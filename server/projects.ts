// Project folders and timeline.json reading/writing.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveSnapshot, type SnapshotReason } from "./history.ts";
import { allClipIds, CURRENT_VERSION, emptyTimeline, nextId, parseTimelineJson, round3, type ParseResult, type Source, type Timeline } from "../schema/timeline.ts";
import type { MediaInfo } from "./ffmpeg.ts";

export const PROJECT_FOLDERS = ["media", "proxies", "peaks", "exports", "history"] as const;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class UserError extends Error {
  statusCode: number;
  /** A short machine-readable reason the browser can react to, e.g. "conflict". */
  code?: string;
  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function checkProjectName(name: string): void {
  if (!PROJECT_NAME.test(name)) {
    throw new UserError(
      `"${name}" can't be used as a project name. Use letters, digits, - and _ only (no spaces), for example "client-interview-oct".`,
    );
  }
}

export async function listProjects(projectsDir: string): Promise<string[]> {
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && PROJECT_NAME.test(e.name) && (await exists(path.join(projectsDir, e.name, "timeline.json")))) {
      names.push(e.name);
    }
  }
  return names.sort();
}

export async function createProject(projectsDir: string, name: string): Promise<void> {
  checkProjectName(name);
  const dir = path.join(projectsDir, name);
  if (await exists(path.join(dir, "timeline.json"))) {
    throw new UserError(`A project called "${name}" already exists. Open it from the list, or pick another name.`, 409);
  }
  for (const folder of PROJECT_FOLDERS) await mkdir(path.join(dir, folder), { recursive: true });
  await writeTimeline(dir, emptyTimeline(name));
}

/** Resolves a project folder, making sure it exists. */
export async function openProject(projectsDir: string, name: string): Promise<string> {
  checkProjectName(name);
  const dir = path.join(projectsDir, name);
  if (!(await exists(path.join(dir, "timeline.json")))) {
    throw new UserError(`There is no project called "${name}". Check the name, or create it from the project list.`, 404);
  }
  // Generated folders are safe to delete; recreate any that are missing.
  for (const folder of PROJECT_FOLDERS) await mkdir(path.join(dir, folder), { recursive: true });
  return dir;
}

/** Identifies one exact version of timeline.json: a hash of its bytes. */
export function revisionOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Reads and validates timeline.json. `text` and `revision` are null when the file can't be read. */
export async function readTimeline(projectDir: string): Promise<ParseResult & { text: string | null; revision: string | null }> {
  let text: string;
  try {
    text = await readFile(path.join(projectDir, "timeline.json"), "utf8");
  } catch (err) {
    return { ok: false, errors: [`timeline.json could not be read (${(err as Error).message}).`], text: null, revision: null };
  }
  return { ...parseTimelineJson(text), text, revision: revisionOf(text) };
}

/** The exact text written to timeline.json for a timeline (always the current format version). */
export function formatTimeline(timeline: Timeline): string {
  return JSON.stringify({ ...timeline, version: CURRENT_VERSION }, null, 2) + "\n";
}

/**
 * Atomic write: write a temp file next to timeline.json, then rename it over the
 * original. Returns the revision of what was written.
 *
 * With `snapshot`, the file being replaced is first saved to history/ for that reason.
 * Otherwise a version 1 file is saved as an "upgrade" snapshot before it's rewritten
 * in the version 2 format.
 */
export async function writeTimeline(projectDir: string, timeline: Timeline, options: { snapshot?: SnapshotReason } = {}): Promise<string> {
  const file = path.join(projectDir, "timeline.json");
  const previous = await readFile(file, "utf8").catch(() => null);
  if (previous !== null) {
    const reason = options.snapshot ?? (isVersion1(previous) ? "upgrade" : null);
    if (reason) await saveSnapshot(projectDir, previous, reason);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = formatTimeline(timeline);
  await writeFile(tmp, text);
  // On Windows the rename can briefly fail while another program has the file open.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, file);
      return revisionOf(text);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after any earlier call with the same key has finished. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  return next;
}

/** Makes an uploaded file name safe and unique inside media/. */
export async function mediaFileName(projectDir: string, uploadedName: string): Promise<string> {
  const base = path.basename(uploadedName.replaceAll("\\", "/"));
  const ext = path.extname(base).replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
  const stem = base.slice(0, base.length - path.extname(base).length).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "video";
  let name = `${stem}${ext}`;
  for (let n = 2; await exists(path.join(projectDir, "media", name)); n++) name = `${stem}-${n}${ext}`;
  return name;
}

/** Throws a clear error if the drive can't hold a copy of `bytes` plus some room for proxies. */
export async function checkFreeSpace(projectDir: string, bytes: number): Promise<void> {
  const fs = await statfs(projectDir);
  const free = fs.bavail * fs.bsize;
  const needed = bytes * 1.1 + 200 * 1024 * 1024;
  if (free < needed) {
    throw new UserError(
      `There isn't enough free disk space to copy this file into the project. It needs about ${gb(needed)} ` +
        `(the file plus room for its proxy), but only ${gb(free)} is free on that drive. ` +
        "Free up some space, then try the import again.",
      507,
    );
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Where an imported file goes: by default video and images to the main track, audio-only to music. */
export type ImportPlacement = {
  to?: "main" | "voice" | "music" | "none";
  /**
   * Voice and music: timeline time where the clip starts (images and video always go at
   * the end of the main track). Music defaults to 0; voice
   * defaults to the end of the last voiceover clip, so narration imported in order lines up.
   */
  at?: number;
};

/** How long an imported image shows at first. */
export const IMPORTED_IMAGE_SECONDS = 3;

export type ImportedSource = {
  timeline: Timeline;
  source: Source;
  /** The clip added for it, or null with `to: "none"`. */
  clip: { id: string; track: "main" | "voice" | "music" } | null;
};

/**
 * Adds an imported file to the timeline: a new source, plus a clip covering the whole
 * file. A video goes at the end of the main track; an audio-only file (music) goes on
 * the music track at the start of the timeline (or `at`), at volume 0.3 so it sits
 * under speech. A voiceover goes after the last voiceover clip (or at `at`), at full
 * volume. A still image goes at the end of the main track, showing for 3 seconds. Sets
 * the project fps and resolution from the first video.
 */
export function addImportedSource(tl: Timeline, mediaPath: string, info: MediaInfo, placement: ImportPlacement = {}): ImportedSource {
  const to = placement.to ?? (info.hasVideo ? "main" : "music");
  if (info.image && (to === "music" || to === "voice")) {
    throw new UserError(`${mediaPath} is a still image, so it can only go on the main track (or --to none).`);
  }
  if (to === "main" && !info.hasVideo) {
    throw new UserError(`${mediaPath} has no picture, so it can't go on the main track. Put it on the music track instead.`);
  }
  if ((to === "music" || to === "voice") && info.audioChannels === 0) {
    throw new UserError(`${mediaPath} has no sound, so it can't go on the ${to === "voice" ? "voiceover" : "music"} track.`);
  }
  const id = nextId(tl.sources.map((s) => s.id), "src");
  const source: Source = info.image
    ? { id, kind: "image", path: mediaPath, width: info.width, height: info.height }
    : { id, path: mediaPath, duration: info.duration };
  if (!info.image) {
    if (info.fps) source.fps = info.fps;
    if (info.width && info.height) {
      source.width = info.width;
      source.height = info.height;
    }
    source.audioChannels = info.audioChannels;
  }

  const out = info.image ? IMPORTED_IMAGE_SECONDS : round3(info.duration);
  const main = [...tl.tracks.main];
  const voice = [...(tl.tracks.voice ?? [])];
  const music = [...(tl.tracks.music ?? [])];
  let clip: ImportedSource["clip"] = null;
  if (to === "main") {
    clip = { id: nextId(allClipIds(tl), "c"), track: "main" };
    main.push(info.image ? { id: clip.id, sourceId: source.id, in: 0, out } : { id: clip.id, sourceId: source.id, in: 0, out, speed: 1, volume: 1, muted: false });
  } else if (to === "music") {
    clip = { id: nextId(allClipIds(tl), "m"), track: "music" };
    music.push({ id: clip.id, sourceId: source.id, start: round3(Math.max(0, placement.at ?? 0)), in: 0, out, volume: 0.3 });
  } else if (to === "voice") {
    const lastEnd = Math.max(0, ...voice.map((v) => v.start + v.out - v.in));
    const start = round3(Math.max(0, placement.at ?? lastEnd));
    const other = voice.find((v) => start < v.start + v.out - v.in - 1e-6 && v.start < start + out - 1e-6);
    if (other) {
      throw new UserError(
        `${mediaPath} would overlap voiceover clip ${other.id} (${other.start}–${round3(other.start + other.out - other.in)} s on the timeline). ` +
          `Voiceover clips can't overlap: choose a start of ${round3(lastEnd)} s or later, or leave it out to add it after the last one.`,
      );
    }
    clip = { id: nextId(allClipIds(tl), "v"), track: "voice" };
    voice.push({ id: clip.id, sourceId: source.id, start, in: 0, out, volume: 1 });
  }

  // Rebuilt in the spec's key order so the file stays easy to read.
  const timeline: Timeline = {
    version: tl.version,
    project: tl.project,
    // Only a video sets these: a photo's size is rarely the size the video should be.
    fps: tl.fps ?? source.fps,
    resolution: tl.resolution ?? (!info.image && source.width && source.height ? { width: source.width, height: source.height } : undefined),
    sources: [...tl.sources, source],
    tracks: { main },
  };
  if (voice.length) timeline.tracks.voice = voice;
  if (music.length) timeline.tracks.music = music;
  if (tl.tracks.mix) timeline.tracks.mix = tl.tracks.mix;
  return { timeline, source, clip };
}

export async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

function isVersion1(text: string): boolean {
  try {
    return (JSON.parse(text.replace(/^\uFEFF/, "")) as { version?: unknown }).version === 1;
  } catch {
    return false;
  }
}
