// Export: turns timeline.json into one ffmpeg command that renders the main track from
// the original media (never the proxies). Clip timing comes from schema/sequence.ts,
// the same code the browser player uses, so preview and export agree.
//
// ffmpeg runs from inside the project folder, so the command uses short relative paths
// (media/..., exports/...). The command and its filter graph are saved next to each
// export and can be run again by hand.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DUCK_RAMP, duckDb, layoutMain, totalDuration, voiceSpans, type DuckSpan } from "../schema/sequence.ts";
import { hasAudio, isImage, type MainClip, type MusicClip, type Timeline, type VoiceClip } from "../schema/timeline.ts";
import { probe, runFfmpeg, withProgressArgs } from "./ffmpeg.ts";
import { localStamp } from "./history.ts";
import { exists } from "./projects.ts";

export type Preset = "final" | "preview";
export const PRESETS: Preset[] = ["final", "preview"];

const AUDIO_RATE = 48000;
const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`;

/** Samples per block while music is ducked: 5 ms, so a 0.25 s ramp moves in 50 small steps. */
const DUCK_BLOCK = AUDIO_RATE / 200;

const ENCODING: Record<Preset, string[]> = {
  // Source resolution, high quality.
  final: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"],
  // 720p, fast to encode, smaller file.
  preview: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"],
};

/** Output picture size: the timeline's resolution, or for previews its shorter side at 720 (never upscaled). */
export function outputSize(tl: Timeline, preset: Preset): { width: number; height: number } {
  // Without a set resolution, the first video's size (a photo's only when there's no video).
  const used = tl.tracks.main.map((c) => tl.sources.find((s) => s.id === c.sourceId)).filter((s) => s?.width && s.height);
  const firstUsed = used.find((s) => !isImage(s)) ?? used[0];
  const base = tl.resolution ?? (firstUsed ? { width: firstUsed.width!, height: firstUsed.height! } : { width: 1920, height: 1080 });
  const scale = preset === "preview" ? Math.min(1, 720 / Math.min(base.width, base.height)) : 1;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2); // H.264 needs even sizes
  return { width: even(base.width * scale), height: even(base.height * scale) };
}

/**
 * atempo filters for a speed. Each atempo step stays within 0.5–2.0, which every ffmpeg
 * version accepts, so 4x becomes 2x then 2x.
 */
export function atempoChain(speed: number): string[] {
  const chain: string[] = [];
  let rest = speed;
  while (rest > 2) {
    chain.push("atempo=2");
    rest /= 2;
  }
  while (rest < 0.5) {
    chain.push("atempo=0.5");
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-9) chain.push(`atempo=${num(rest)}`);
  return chain;
}

/** A number written without exponent notation or float noise. */
function num(v: number): string {
  return String(Number(v.toFixed(6)));
}

/**
 * How the export reads the media. Clips that play forward through the same file share
 * one input; a new input (seeking straight to its start) begins wherever the edit jumps
 * back, skips ahead more than MAX_SHARED_GAP, or switches file. Normal edits read each
 * file once, and reordered edits don't make ffmpeg hold frames in memory until their
 * turn comes (measured: 30 reversed clips from one 1080p input peaked at 5.8 GB).
 * Each extra input costs ffmpeg about 25 MB.
 */
type Input = { path: string; start: number; end: number; image?: boolean };

/** Skipping more than this many seconds of source is faster by seeking than by decoding through it. */
const MAX_SHARED_GAP = 10;

function planInputs(tl: Timeline): { inputs: Input[]; clipInput: number[] } {
  const sources = new Map(tl.sources.map((s) => [s.id, s]));
  const inputs: Input[] = [];
  const clipInput: number[] = [];
  let lastSource: string | null = null;
  for (const c of tl.tracks.main) {
    const source = sources.get(c.sourceId)!;
    if (isImage(source)) {
      // A still image is read as a looped picture, as long as the clip shows it.
      inputs.push({ path: source.path, start: 0, end: c.out, image: true });
      lastSource = null;
      clipInput.push(inputs.length - 1);
      continue;
    }
    const current = inputs[inputs.length - 1];
    const continues = current && lastSource === c.sourceId && c.in >= current.end && c.in - current.end <= MAX_SHARED_GAP;
    if (current && continues) current.end = c.out;
    else inputs.push({ path: sources.get(c.sourceId)!.path, start: c.in, end: c.out });
    lastSource = c.sourceId;
    clipInput.push(inputs.length - 1);
  }
  return { inputs, clipInput };
}

export type ExportCommand = {
  /** ffmpeg arguments, before the standard quiet/progress flags. Paths are relative to the project folder. */
  args: string[];
  /** The filter graph. ffmpeg reads it from `graphFile`, because it can be too long for a command line. */
  graph: string;
};

/** Builds the ffmpeg command that renders the main track to `output`. */
export function buildExport(tl: Timeline, preset: Preset, output: string, graphFile: string): ExportCommand {
  // Main track: cut, sped up and joined in order. Voiceover and music: mixed with it.
  const placed = layoutMain(tl);
  if (placed.length === 0) throw new Error("There is nothing to export: the timeline has no clips. Import a video first.");
  const fps = tl.fps ?? 25;
  const { width, height } = outputSize(tl, preset);
  const sources = new Map(tl.sources.map((s) => [s.id, s]));
  const { inputs, clipInput } = planInputs(tl);

  const graph: string[] = [];
  const segments: string[] = [];
  placed.forEach((p, i) => {
    const c = p.clip;
    const input = clipInput[i];
    // Inside an input, time counts from where that input starts reading.
    const from = num(c.in - inputs[input].start);
    const to = num(c.out - inputs[input].start);
    const video: string[] = [];
    if (inputs[input].image) {
      video.push(...imageChain(c, width, height, fps, preset));
    } else {
      video.push(`trim=start=${from}:end=${to}`, "setpts=PTS-STARTPTS");
      if (p.speed !== 1) video.push(`setpts=PTS/${num(p.speed)}`);
      // Every clip is fitted to the same size and frame rate so they can be joined.
      video.push(...fitChain(c.fit, width, height));
    }
    video.push("setsar=1", `fps=${num(fps)}`, "format=yuv420p");
    graph.push(`[${input}:v:0]${video.join(",")}[v${i}]`);

    if (c.muted || !hasAudio(sources.get(c.sourceId))) {
      // Silence of exactly the clip's length keeps sound and picture in step.
      graph.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${num(p.end - p.start)},${AUDIO_FORMAT}[a${i}]`);
    } else {
      const audio = [`atrim=start=${from}:end=${to}`, "asetpts=PTS-STARTPTS", ...atempoChain(p.speed)];
      if ((c.volume ?? 1) !== 1) audio.push(`volume=${num(c.volume ?? 1)}`);
      audio.push(AUDIO_FORMAT);
      graph.push(`[${input}:a:0]${audio.join(",")}[a${i}]`);
    }
    segments.push(`[v${i}][a${i}]`);
  });
  const total = totalDuration(placed);
  const playable = (c: MusicClip | VoiceClip) => c.start < total && hasAudio(sources.get(c.sourceId));
  const placedAudio = [
    ...(tl.tracks.voice ?? []).filter(playable).map((clip) => ({ clip, music: false })),
    ...(tl.tracks.music ?? []).filter(playable).map((clip) => ({ clip, music: true })),
  ];
  graph.push(`${segments.join("")}concat=n=${placed.length}:v=1:a=1[outv][${placedAudio.length ? "dialog" : "outa"}]`);

  // Voiceover and music: each clip is its own input, faded, set to its volume, lowered
  // under voice (music only), and delayed to its start; then mixed with the main track's
  // sound. normalize=0 keeps every level as set, and duration=first ends the mix with the
  // main track.
  const spans = voiceSpans(tl.tracks.voice);
  const db = duckDb(tl);
  const audioInputs: string[] = [];
  placedAudio.forEach(({ clip: m, music }, k) => {
    const input = inputs.length + k;
    const length = m.out - m.in;
    audioInputs.push("-ss", num(m.in), "-t", num(length), "-i", sources.get(m.sourceId)!.path);
    const chain = [`atrim=start=0:end=${num(length)}`, "asetpts=PTS-STARTPTS"];
    if (m.fadeIn) chain.push(`afade=t=in:st=0:d=${num(Math.min(m.fadeIn, length))}`);
    if (m.fadeOut) chain.push(`afade=t=out:st=${num(Math.max(0, length - m.fadeOut))}:d=${num(Math.min(m.fadeOut, length))}`);
    if ((m.volume ?? 1) !== 1) chain.push(`volume=${num(m.volume ?? 1)}`);
    const duck = music ? duckExpression(spans, db, m.start, m.start + length) : null;
    // volume re-evaluates once per block of samples, so short blocks keep the ramps smooth.
    if (duck) chain.push(`asetnsamples=n=${DUCK_BLOCK}:p=0`, `volume=volume='${duck}':eval=frame`);
    chain.push(AUDIO_FORMAT, `adelay=${Math.round(m.start * 1000)}:all=1`);
    graph.push(`[${input}:a:0]${chain.join(",")}[${music ? "m" : "n"}${k}]`);
  });
  if (placedAudio.length) {
    const mixInputs = ["[dialog]", ...placedAudio.map(({ music }, k) => `[${music ? "m" : "n"}${k}]`)].join("");
    graph.push(`${mixInputs}amix=inputs=${placedAudio.length + 1}:duration=first:normalize=0,${AUDIO_FORMAT}[outa]`);
  }

  const args = [
    ...inputs.flatMap((inp) =>
      inp.image
        ? ["-loop", "1", "-framerate", num(fps), "-t", num(inp.end), "-i", inp.path]
        : ["-ss", num(inp.start), "-t", num(inp.end - inp.start), "-i", inp.path],
    ),
    ...audioInputs,
    "-/filter_complex",
    graphFile,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    ...ENCODING[preset],
    "-ar",
    String(AUDIO_RATE),
    "-movflags",
    "+faststart",
    output,
  ];
  // One filter chain per line, so the saved file is readable.
  return { args, graph: graph.join(";\n") + "\n" };
}

/** Fits a picture into width x height: whole with black bars ("contain"), or filling the frame and cropping the edges ("cover"). */
function fitChain(fit: MainClip["fit"], width: number, height: number): string[] {
  return fit === "cover"
    ? [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`]
    : [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`];
}

/**
 * Final exports fit zooming images at this multiple of the output size, so zoomed-in
 * detail stays sharp. It roughly doubles their render time (about 3 s per second of
 * 1080x1920 zoom), so previews skip it.
 */
const ZOOM_SUPERSAMPLE: Record<Preset, number> = { final: 2, preview: 1 };

/**
 * An image clip's picture: fitted into the frame and, with a zoom, cropped to the
 * window zoomWindow (schema/sequence.ts) gives for each frame. The `perspective` filter
 * samples that window with sub-pixel precision every frame, so the zoom is smooth
 * (zoompan rounds to whole pixels and jitters).
 */
function imageChain(c: MainClip, width: number, height: number, fps: number, preset: Preset): string[] {
  if (!c.zoom) return fitChain(c.fit, width, height);
  const k = ZOOM_SUPERSAMPLE[preset];
  return [
    ...fitChain(c.fit, width * k, height * k),
    "format=yuv444p",
    `perspective=${zoomCorners(c, fps)}:sense=source:interpolation=cubic:eval=frame`,
    ...(k === 1 ? [] : [`scale=${width}:${height}`]),
  ];
}

/**
 * perspective corner expressions for an image clip's zoom. perspective counts frames
 * from 1 in `in`, so frame `in - 1` shows at (in - 1) / fps seconds into the clip; W, H
 * are the frame size. Same
 * formulas as zoomAt and zoomWindow: scale from→to linearly, window left = focus x ×
 * (W − W / scale).
 */
export function zoomCorners(c: MainClip, fps: number): string {
  const zoom = c.zoom!;
  const scale = `(${num(zoom.from)}+${num(zoom.to - zoom.from)}*clip((in-1)/${num(fps * c.out)},0,1))`;
  const fx = num(zoom.focus?.x ?? 0.5);
  const fy = num(zoom.focus?.y ?? 0.5);
  const left = `(${fx}*(W-W/${scale}))`;
  const top = `(${fy}*(H-H/${scale}))`;
  const right = `(${left}+W/${scale})`;
  const bottom = `(${top}+H/${scale})`;
  return [
    `x0='${left}'`, `y0='${top}'`,
    `x1='${right}'`, `y1='${top}'`,
    `x2='${left}'`, `y2='${bottom}'`,
    `x3='${right}'`, `y3='${bottom}'`,
  ].join(":");
}

/**
 * Music ducking as an ffmpeg `volume` expression for a music clip playing from timeline
 * time `from` to `to`: the same curve as duckGainAt in schema/sequence.ts,
 * 10^(dB × depth / 20), where depth is the largest of one linear ramp-up, hold,
 * ramp-down shape per voice clip. `t` in the expression counts from the clip's start.
 * Returns null when ducking is off or no voice clip comes near the music clip.
 */
export function duckExpression(spans: DuckSpan[], db: number, from: number, to: number): string | null {
  if (!db) return null;
  const near = spans.filter((s) => s.to + DUCK_RAMP > from && s.from - DUCK_RAMP < to);
  if (!near.length) return null;
  // clip((t - rampStart) / ramp, 0, 1) * clip((rampEnd - t) / ramp, 0, 1), in clip-local time.
  const shapes = near.map(
    (s) => `clip((t${minus(s.from - DUCK_RAMP - from)})/${num(DUCK_RAMP)},0,1)*clip((${num(s.to + DUCK_RAMP - from)}-t)/${num(DUCK_RAMP)},0,1)`,
  );
  const depth = shapes.reduce((acc, shape) => `max(${acc},${shape})`);
  return `pow(10,${num(db)}*${depth}/20)`;
}

/** "-2.5" or "+1" for subtracting `v`, so expressions never contain "--". */
function minus(v: number): string {
  return v >= 0 ? `-${num(v)}` : `+${num(-v)}`;
}

/** A command line that can be pasted into a terminal (bash or PowerShell). */
export function formatCommand(args: string[]): string {
  return ["ffmpeg", ...args].map((a) => (/^[\w./:=+-]+$/.test(a) ? a : `"${a}"`)).join(" ");
}

export type ExportResult = {
  /** File name inside exports/. */
  file: string;
  /** File name of the saved ffmpeg command inside exports/. */
  commandFile: string;
  /** File name of the saved filter graph inside exports/. */
  graphFile: string;
  /** Timeline duration in seconds. */
  expectedDuration: number;
  /** Duration of the rendered file, from ffprobe. */
  duration: number;
};

/** Picks a new export name like "AI_preview_2026-10-14_09-30-05". */
export async function newExportName(
  projectDir: string,
  tl: Timeline,
  preset: Preset,
  taken: Set<string> = new Set(),
  now = new Date(),
): Promise<string> {
  const project = (tl.project ?? path.basename(projectDir)).replace(/[^A-Za-z0-9_-]+/g, "_");
  const base = `${project}_${preset}_${localStamp(now)}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(name) && !(await exists(path.join(projectDir, "exports", `${name}.mp4`)))) return name;
  }
}

/**
 * Renders the timeline to exports/<name>.mp4, saving the command as
 * exports/<name>.ffmpeg.txt and the filter graph as exports/<name>.filtergraph.txt.
 */
export async function runExport(
  projectDir: string,
  tl: Timeline,
  preset: Preset,
  name: string,
  onProgress: (p: number) => void,
): Promise<ExportResult> {
  for (const s of tl.sources) {
    const used = [...tl.tracks.main, ...(tl.tracks.voice ?? []), ...(tl.tracks.music ?? [])].some((c) => c.sourceId === s.id);
    if (used && !(await exists(path.join(projectDir, s.path)))) {
      throw new Error(`The original file ${s.path} is missing from the project folder, so the export can't run. Put it back with the same name.`);
    }
  }
  const file = `${name}.mp4`;
  const commandFile = `${name}.ffmpeg.txt`;
  const graphFile = `${name}.filtergraph.txt`;
  const { args, graph } = buildExport(tl, preset, `exports/${file}`, `exports/${graphFile}`);
  const expectedDuration = totalDuration(layoutMain(tl));

  await mkdir(path.join(projectDir, "exports"), { recursive: true });
  await writeFile(path.join(projectDir, "exports", graphFile), graph);
  await writeFile(
    path.join(projectDir, "exports", commandFile),
    [
      `# ${preset} export of ${tl.project ?? path.basename(projectDir)}, ${new Date().toISOString()}`,
      `# Expected length: ${expectedDuration.toFixed(3)} s`,
      `# Run from the project folder: ${projectDir}`,
      `# How each clip is cut, sped up and joined is in exports/${graphFile}.`,
      formatCommand(withProgressArgs(args)),
      "",
    ].join("\n"),
  );
  try {
    await runFfmpeg(args, expectedDuration, onProgress, projectDir);
  } catch (err) {
    await rm(path.join(projectDir, "exports", file), { force: true });
    const message = (err as Error).message;
    if (message.includes("Unrecognized option '/filter_complex'")) {
      throw new Error("Your ffmpeg is too old to export: version 7 or newer is needed. Update it (see the README), then try again.");
    }
    throw new Error(`The export failed. ${message} The command is saved in exports/${commandFile}.`);
  }
  const info = await probe(path.join(projectDir, "exports", file));
  return { file, commandFile, graphFile, expectedDuration, duration: info.duration };
}
