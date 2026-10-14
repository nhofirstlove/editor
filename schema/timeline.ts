// The timeline format (SPEC.md section 5) as a zod schema, plus helpers that turn
// validation problems into messages a non-developer can act on.
//
// schema/timeline.schema.json is generated from this file: run `npm run schema` after
// changing it. A test fails if the two drift apart.

import { z } from "zod";

const ROUNDING_TOLERANCE = 1e-6;
/** How far `out` may pass the source duration (ffprobe durations are rounded). */
export const DURATION_TOLERANCE = 0.001;

function hasAtMost3Decimals(v: number): boolean {
  return Math.abs(v * 1000 - Math.round(v * 1000)) < ROUNDING_TOLERANCE;
}

const seconds = () =>
  z
    .number({ error: "must be a number of seconds" })
    .min(0, { error: "must be 0 or more" })
    .refine(hasAtMost3Decimals, { error: "must be rounded to 3 decimals (for example 12.345)" });

const id = () => z.string({ error: "must be text" }).min(1, { error: "must not be empty" });

/** Image clips: shortest and longest time an image may show, in seconds. */
export const IMAGE_MIN_SECONDS = 0.04;
export const IMAGE_MAX_SECONDS = 3600;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;

const zoomScale = () =>
  z
    .number({ error: "must be a number" })
    .min(ZOOM_MIN, { error: "must be between 1.0 and 3.0" })
    .max(ZOOM_MAX, { error: "must be between 1.0 and 3.0" });

const fraction = () =>
  z.number({ error: "must be a number" }).min(0, { error: "must be between 0 and 1" }).max(1, { error: "must be between 0 and 1" });

const volume = () =>
  z
    .number({ error: "must be a number" })
    .min(0, { error: "must be between 0.0 and 2.0" })
    .max(2, { error: "must be between 0.0 and 2.0" })
    .meta({ default: 1, description: "1.0 = original level." });

export const sourceSchema = z
  .strictObject({
    id: z
      .string({ error: "must be text" })
      .regex(/^[A-Za-z0-9_-]+$/, { error: "may only use letters, digits, - and _ (for example \"src1\")" }),
    kind: z.enum(["media", "image"], { error: 'must be "media" or "image"' }).optional().meta({
      default: "media",
      description: '"media" (audio and/or video) or "image" (a still picture: width and height, no duration, fps or audioChannels).',
    }),
    path: z
      .string({ error: "must be text" })
      // Inside media/, forward slashes only, no ".." segments.
      .regex(/^media\/(?!(.*\/)?\.\.(\/|$))[^\\]+$/, {
        error: "must be a path inside media/ using forward slashes (for example \"media/interview.mp4\")",
      })
      .meta({ description: "Relative to the project folder, inside media/ (e.g. \"media/interview_take2.mp4\")." }),
    duration: z.number({ error: "must be a number of seconds" }).positive({ error: "must be more than 0" }).optional()
      .meta({ description: "Seconds, from ffprobe." }),
    fps: z.number({ error: "must be a number" }).positive({ error: "must be more than 0" }).optional(),
    width: z.int({ error: "must be a whole number" }).positive({ error: "must be more than 0" }).optional()
      .meta({ description: "Display width in pixels, from ffprobe." }),
    height: z.int({ error: "must be a whole number" }).positive({ error: "must be more than 0" }).optional()
      .meta({ description: "Display height in pixels, from ffprobe." }),
    audioChannels: z.int({ error: "must be a whole number" }).min(0, { error: "must be 0 or more" }).optional()
      .meta({ description: "Channels in the first audio stream; 0 when the file has no audio." }),
  })
  .meta({ id: "source", description: "A media file used by the edit. Source ids must be unique." });

export const mainClipSchema = z
  .strictObject({
    id: id().meta({ description: "Unique and stable. Keep it when the clip is edited." }),
    sourceId: id(),
    in: seconds().meta({ description: "Source time where the clip starts." }),
    out: seconds().meta({ description: "Source time where the clip ends." }),
    speed: z
      .number({ error: "must be a number" })
      .min(0.25, { error: "must be between 0.25 and 4.0" })
      .max(4, { error: "must be between 0.25 and 4.0" })
      .optional()
      .meta({ default: 1 }),
    volume: volume().optional(),
    muted: z.boolean({ error: "must be true or false" }).optional().meta({ default: false }),
    fit: z.enum(["contain", "cover"], { error: 'must be "contain" or "cover"' }).optional().meta({
      default: "contain",
      description: '"contain": the whole picture, with black bars. "cover": fill the frame, cropping the edges.',
    }),
    zoom: z
      .strictObject({
        from: zoomScale(),
        to: zoomScale(),
        focus: z
          .strictObject({ x: fraction(), y: fraction() })
          .optional()
          .meta({ description: "The point that stays put while zooming, as fractions of the frame (default 0.5, 0.5: the centre)." }),
      })
      .optional()
      .meta({ description: "Image clips only: a slow zoom, scaling linearly from `from` to `to` over the clip." }),
    label: z.string({ error: "must be text" }).optional(),
    note: z.string({ error: "must be text" }).optional()
      .meta({ description: "Written by a human. Don't cut or change this clip unless asked." }),
  })
  .refine((c) => c.in < c.out, { error: (iss) => inOutMessage(iss.input) })
  .meta({
    id: "mainClip",
    description:
      "Must satisfy in < out <= source duration. sourceId must match a source. Timeline duration = (out - in) / speed. " +
      "On an image source: in is 0, out is how long the image shows (0.04–3600 s), and speed is 1.",
  });

// Music and voice clips have the same shape: an audio clip placed at an explicit time.
const placedAudioClip = (what: string) =>
  z
    .strictObject({
      id: id(),
      sourceId: id(),
      start: seconds().meta({ description: `Timeline time where the ${what} starts.` }),
      in: seconds(),
      out: seconds(),
      volume: volume().optional(),
      fadeIn: seconds().optional(),
      fadeOut: seconds().optional(),
      label: z.string({ error: "must be text" }).optional(),
      note: z.string({ error: "must be text" }).optional(),
    })
    .refine((c) => c.in < c.out, { error: (iss) => inOutMessage(iss.input) });

export const musicClipSchema = placedAudioClip("music")
  .meta({ id: "musicClip", description: "Must satisfy in < out <= source duration. sourceId must match a source." });

export const voiceClipSchema = placedAudioClip("voiceover")
  .meta({
    id: "voiceClip",
    description: "Must satisfy in < out <= source duration. sourceId must match a source. Voice clips must not overlap.",
  });

/** The most music can be lowered under voice, in dB. */
export const MAX_DUCK_DB = -30;

function inOutMessage(input: unknown): string {
  const c = input as { in: number; out: number };
  return `"in" (${c.in}) must be less than "out" (${c.out})`;
}

const timelineObject = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)], { error: "must be 1 or 2" }).meta({
    description: "Format version. Version 2 is a superset of 1; the editor and CLI write 2.",
  }),
  project: z.string({ error: "must be text" }).optional()
    .meta({ description: "Project folder name, e.g. \"client-interview-oct\"." }),
  fps: z.number({ error: "must be a number" }).positive({ error: "must be more than 0" }).optional(),
  resolution: z
    .strictObject({
      width: z.int({ error: "must be a whole number" }).positive({ error: "must be more than 0" }),
      height: z.int({ error: "must be a whole number" }).positive({ error: "must be more than 0" }),
    })
    .optional(),
  sources: z.array(sourceSchema, { error: "must be a list" }),
  tracks: z.strictObject({
    main: z.array(mainClipSchema, { error: "must be a list" }).meta({
      description: "Clips play back-to-back in array order with no gaps. Timeline positions are derived, never stored.",
    }),
    voice: z.array(voiceClipSchema, { error: "must be a list" }).optional()
      .meta({ description: "Voiceover clips (v2), each placed at an explicit timeline time. They must not overlap." }),
    music: z.array(musicClipSchema, { error: "must be a list" }).optional()
      .meta({ description: "Music clips (Milestone 6), each placed at an explicit timeline time." }),
    mix: z
      .strictObject({
        duckMusicUnderVoice: z
          .number({ error: "must be a number of decibels" })
          .min(MAX_DUCK_DB, { error: "must be between -30 and 0 (decibels)" })
          .max(0, { error: "must be between -30 and 0 (decibels)" })
          .optional()
          .meta({
            default: 0,
            description: "Decibels music is lowered while a voice clip plays, ramping over 0.25 s each side. 0 = off.",
          }),
      })
      .optional(),
  }),
});

export const timelineSchema = timelineObject
  .superRefine(checkReferences)
  .meta({
    title: "Timeline (v2)",
    description: "One video edit. All times are seconds, rounded to 3 decimals. Clip ids must be unique across all tracks.",
  });

export type Timeline = z.infer<typeof timelineObject>;
export type Source = z.infer<typeof sourceSchema>;
export type MainClip = z.infer<typeof mainClipSchema>;
export type MusicClip = z.infer<typeof musicClipSchema>;
export type VoiceClip = z.infer<typeof voiceClipSchema>;

// Rules that span several objects: unique ids, sourceId references, clip within source.
function checkReferences(tl: Timeline, ctx: z.RefinementCtx): void {
  const sources = new Map<string, Source>();
  tl.sources.forEach((s, i) => {
    if (sources.has(s.id)) {
      ctx.addIssue({ code: "custom", path: ["sources", i, "id"], message: `"id" "${s.id}" is used by more than one source; every source needs its own id` });
    }
    sources.set(s.id, s);
    if (isImage(s)) {
      for (const key of ["duration", "fps", "audioChannels"] as const) {
        if (s[key] !== undefined) {
          ctx.addIssue({ code: "custom", path: ["sources", i, key], message: `"${key}" doesn't apply to an image source; remove it` });
        }
      }
    }
  });

  const clipIds = new Set<string>();
  const tracks = [
    ["main", tl.tracks.main],
    ["voice", tl.tracks.voice ?? []],
    ["music", tl.tracks.music ?? []],
  ] as const;
  for (const [track, clips] of tracks) {
    clips.forEach((c, i) => {
      const at = ["tracks", track, i];
      if (clipIds.has(c.id)) {
        ctx.addIssue({ code: "custom", path: [...at, "id"], message: `"id" "${c.id}" is used by more than one clip; every clip needs a unique id` });
      }
      clipIds.add(c.id);
      const src = sources.get(c.sourceId);
      if (!src) {
        ctx.addIssue({ code: "custom", path: [...at, "sourceId"], message: `"sourceId" "${c.sourceId}" does not match any source in "sources"` });
      } else if (isImage(src)) {
        checkImageClip(c, track, src, at, ctx);
      } else if (track === "main" && (c as MainClip).zoom) {
        ctx.addIssue({ code: "custom", path: [...at, "zoom"], message: `"zoom" only applies to image clips, and "${src.id}" is not an image; remove it` });
      } else if (src.duration !== undefined && c.out > src.duration + DURATION_TOLERANCE) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "out"],
          message: `"out" (${c.out}) is past the end of source "${src.id}" (${src.duration} s long)`,
        });
      }
    });
  }

  // Voice clips must not overlap (touching is fine).
  const voice = (tl.tracks.voice ?? []).map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start);
  for (let k = 1; k < voice.length; k++) {
    const prev = voice[k - 1].c;
    const { c, i } = voice[k];
    const prevEnd = round3(prev.start + prev.out - prev.in);
    if (c.start < prevEnd - ROUNDING_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["tracks", "voice", i, "start"],
        message: `"start" (${c.start}) overlaps voice clip "${prev.id}", which plays until ${prevEnd}; voice clips must not overlap`,
      });
    }
  }
}

/** An image shows from `in` 0 for `out` seconds, at normal speed, on the main track only. */
function checkImageClip(c: MainClip | MusicClip, track: string, src: Source, at: (string | number)[], ctx: z.RefinementCtx): void {
  if (track !== "main") {
    ctx.addIssue({ code: "custom", path: [...at, "sourceId"], message: `"sourceId" "${src.id}" is a still image, which can only go on the main track` });
    return;
  }
  const clip = c as MainClip;
  if (clip.in !== 0) ctx.addIssue({ code: "custom", path: [...at, "in"], message: `"in" must be 0 for an image clip ("out" is how long the image shows)` });
  if (clip.out < IMAGE_MIN_SECONDS || clip.out > IMAGE_MAX_SECONDS) {
    ctx.addIssue({ code: "custom", path: [...at, "out"], message: `"out" (${clip.out}) is how long the image shows, and must be between ${IMAGE_MIN_SECONDS} and ${IMAGE_MAX_SECONDS} seconds` });
  }
  if ((clip.speed ?? 1) !== 1) ctx.addIssue({ code: "custom", path: [...at, "speed"], message: `"speed" must be 1 for an image clip; change "out" to show it for longer or shorter` });
}

/** Whether a source is a still image. */
export function isImage(s: Source | undefined): boolean {
  return s?.kind === "image";
}

/** Whether a source has sound (images never do; for media, unknown counts as yes). */
export function hasAudio(s: Source | undefined): boolean {
  return !!s && !isImage(s) && s.audioChannels !== 0;
}

// ---------------------------------------------------------------------------------
// Parsing and readable errors

export type ParseResult = { ok: true; timeline: Timeline } | { ok: false; errors: string[] };

/** Parse the text of a timeline.json file. Never throws. */
export function parseTimelineJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, errors: [jsonSyntaxMessage(text, (e as Error).message)] };
  }
  return validateTimeline(data);
}

/** Validate an already-parsed timeline object. Never throws. */
export function validateTimeline(data: unknown): ParseResult {
  const result = timelineSchema.safeParse(data);
  if (result.success) return { ok: true, timeline: result.data };
  return { ok: false, errors: result.error.issues.map((issue) => describeIssue(issue, data)) };
}

function jsonSyntaxMessage(text: string, raw: string): string {
  const detail = raw.replace(/\s*\(line \d+ column \d+\)/, "").replace(/ in JSON at position \d+/, "");
  const pos = /position (\d+)/.exec(raw);
  let where = "";
  if (pos) {
    const before = text.replace(/^﻿/, "").slice(0, Number(pos[1]));
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    where = ` near line ${line}, column ${column}`;
  }
  return `The file is not valid JSON${where} (${detail}). Look for a missing comma, quote or bracket there.`;
}

function describeIssue(issue: z.core.$ZodIssue, data: unknown): string {
  const path = issue.path;
  const last = path[path.length - 1];
  const fieldIsLast = typeof last === "string";
  const where = describeLocation(fieldIsLast ? path.slice(0, -1) : path, data);
  const prefix = where ? `${where}: ` : "";

  // Messages that name their own fields (cross-field rules like in < out) are used as they are.
  if (issue.message.startsWith("\"")) return prefix + issue.message;

  if (issue.code === "unrecognized_keys") {
    const msgs = issue.keys.map((k) => {
      if (k === "start" && path[0] === "tracks" && path[1] === "main") {
        return `main-track clips must not have "start"; their position comes from clip order`;
      }
      return `unknown field "${k}"; check the spelling or remove it`;
    });
    return prefix + msgs.join("; ");
  }

  const value = valueAt(data, path);
  if (fieldIsLast) {
    if (issue.code === "invalid_type" && value === undefined) return `${prefix}"${last}" is missing`;
    return `${prefix}"${last}" ${issue.message} (found ${preview(value)})`;
  }
  if (issue.code === "invalid_type" && value === undefined) return `${prefix}is missing`;
  return `${prefix}${issue.message} (found ${preview(value)})`;
}

/** Turns ["tracks", "main", 2] into `tracks.main[2] (clip "c3")`. */
function describeLocation(path: PropertyKey[], data: unknown): string {
  let out = "";
  for (const key of path) out += typeof key === "number" ? `[${key}]` : `${out ? "." : ""}${String(key)}`;
  const target = valueAt(data, path);
  if (path.length && typeof path[path.length - 1] === "number" && target && typeof target === "object") {
    const targetId = (target as { id?: unknown }).id;
    if (typeof targetId === "string" && targetId) {
      out += ` (${path[0] === "sources" ? "source" : "clip"} "${targetId}")`;
    }
  }
  return out;
}

function valueAt(data: unknown, path: PropertyKey[]): unknown {
  let cur = data;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function preview(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

// ---------------------------------------------------------------------------------
// Small helpers shared by the server, CLI and app

/** The format version the editor and CLI write. Version 1 files are read and upgraded. */
export const CURRENT_VERSION = 2;

export function emptyTimeline(project: string): Timeline {
  return { version: CURRENT_VERSION, project, sources: [], tracks: { main: [] } };
}

/** Next free id like "src3" or "c17". */
export function nextId(existing: string[], prefix: string): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of existing) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/** Every clip id in the timeline, across all tracks. */
export function allClipIds(tl: Timeline): string[] {
  return [...tl.tracks.main, ...(tl.tracks.voice ?? []), ...(tl.tracks.music ?? [])].map((c) => c.id);
}

/** Round to 3 decimals, the precision every time in the file uses. */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
