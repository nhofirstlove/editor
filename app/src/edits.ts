// Editing operations. Each takes a timeline and returns a new one (never mutating the
// input), or null when the operation doesn't apply. All times written are rounded to
// 3 decimals; existing clip ids are kept and new clips get new ids.

import { layoutMain, locate, zoomAt } from "../../schema/sequence.ts";
import {
  allClipIds,
  IMAGE_MAX_SECONDS,
  IMAGE_MIN_SECONDS,
  isImage,
  MAX_DUCK_DB,
  nextId,
  round3,
  ZOOM_MAX,
  ZOOM_MIN,
  type MainClip,
  type MusicClip,
  type Timeline,
  type VoiceClip,
} from "../../schema/timeline.ts";

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const VOLUME_MAX = 2;

function withMain(tl: Timeline, main: MainClip[]): Timeline {
  return { ...tl, tracks: { ...tl.tracks, main } };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Shortest a clip may be: one frame of its source (or of the timeline, for an image). */
export function minClipLength(tl: Timeline, clip: MainClip): number {
  const fps = tl.sources.find((s) => s.id === clip.sourceId)?.fps ?? tl.fps ?? 25;
  return Math.max(round3(1 / fps), clipIsImage(tl, clip) ? IMAGE_MIN_SECONDS : 0);
}

function clipIsImage(tl: Timeline, clip: MainClip): boolean {
  return isImage(tl.sources.find((s) => s.id === clip.sourceId));
}

/**
 * The stretch [from, to) of a clip's source time as a clip of its own. An image clip
 * always starts at 0, so its piece is (to - from) long, with the zoom it had over that
 * stretch, so a split or cut image keeps zooming smoothly.
 */
function piece(tl: Timeline, clip: MainClip, from: number, to: number): MainClip {
  if (!clipIsImage(tl, clip)) return { ...clip, in: from, out: to };
  const next: MainClip = { ...clip, in: 0, out: round3(to - from) };
  if (clip.zoom) next.zoom = { ...clip.zoom, from: round6(zoomAt(clip, from)), to: round6(zoomAt(clip, to)) };
  return next;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Splits the clip under timeline time `t`. The first part keeps the id. */
export function splitAt(tl: Timeline, t: number): Timeline | null {
  const hit = locate(layoutMain(tl), t);
  if (!hit) return null;
  const { clip, index } = hit.placed;
  const at = round3(hit.sourceTime);
  const min = minClipLength(tl, clip);
  if (at - clip.in < min || clip.out - at < min) return null; // too close to a cut
  const first = piece(tl, clip, clip.in, at);
  const second: MainClip = { ...piece(tl, clip, at, clip.out), id: nextId(allClipIds(tl), "c") };
  const main = [...tl.tracks.main];
  main.splice(index, 1, first, second);
  return withMain(tl, main);
}

/** Removes a clip; the clips after it move up to close the gap. */
export function rippleDelete(tl: Timeline, clipId: string): Timeline | null {
  const main = tl.tracks.main.filter((c) => c.id !== clipId);
  return main.length === tl.tracks.main.length ? null : withMain(tl, main);
}

/**
 * Moves a clip's in or out point (source time), kept within the source and at least one
 * frame long. For an image clip either edge changes how long the image shows (`in`
 * stays 0; the zoom still runs from start to end).
 */
export function trimClip(tl: Timeline, clipId: string, edge: "in" | "out", value: number): Timeline | null {
  const clip = tl.tracks.main.find((c) => c.id === clipId);
  if (!clip || !Number.isFinite(value)) return null;
  const min = minClipLength(tl, clip);
  if (clipIsImage(tl, clip)) {
    const length = edge === "in" ? clip.out - (value - clip.in) : value;
    const out = round3(clamp(length, min, IMAGE_MAX_SECONDS));
    return out === clip.out ? null : withMain(tl, tl.tracks.main.map((c) => (c.id === clipId ? { ...clip, in: 0, out } : c)));
  }
  const sourceEnd = tl.sources.find((s) => s.id === clip.sourceId)?.duration ?? Infinity;
  const next =
    edge === "in"
      ? { ...clip, in: round3(clamp(value, 0, clip.out - min)) }
      : { ...clip, out: round3(clamp(value, clip.in + min, sourceEnd)) };
  if (next.in === clip.in && next.out === clip.out) return null;
  return withMain(tl, tl.tracks.main.map((c) => (c.id === clipId ? next : c)));
}

export type ClipChanges = Partial<Pick<MainClip, "speed" | "volume" | "muted" | "fit" | "label" | "note">> & {
  /** Image clips: zoom scale at the start and end (both 1 removes the zoom), and the focus point. */
  zoomFrom?: number;
  zoomTo?: number;
  focus?: { x: number; y: number };
};

/**
 * Changes speed, volume, mute, fit, zoom, label or note. Empty text removes the field.
 * Image clips have no speed or sound, so those changes are ignored for them; only image
 * clips can zoom.
 */
export function updateClip(tl: Timeline, clipId: string, changes: ClipChanges): Timeline | null {
  const clip = tl.tracks.main.find((c) => c.id === clipId);
  if (!clip) return null;
  const image = clipIsImage(tl, clip);
  const next: MainClip = { ...clip };
  if (changes.fit !== undefined) {
    if (changes.fit === "contain") delete next.fit;
    else next.fit = changes.fit;
  }
  if (image && (changes.zoomFrom !== undefined || changes.zoomTo !== undefined || changes.focus !== undefined)) {
    const scale = (v: number | undefined, current: number) => (v !== undefined && Number.isFinite(v) ? round3(clamp(v, ZOOM_MIN, ZOOM_MAX)) : current);
    const from = scale(changes.zoomFrom, clip.zoom?.from ?? 1);
    const to = scale(changes.zoomTo, clip.zoom?.to ?? 1);
    const focus = changes.focus ? { x: round3(clamp(changes.focus.x, 0, 1)), y: round3(clamp(changes.focus.y, 0, 1)) } : clip.zoom?.focus;
    if (from === 1 && to === 1) delete next.zoom;
    else next.zoom = focus && (focus.x !== 0.5 || focus.y !== 0.5) ? { from, to, focus } : { from, to };
  }
  const { speed, volume, muted }: ClipChanges = image ? {} : changes;
  if (speed !== undefined && Number.isFinite(speed)) next.speed = round3(clamp(speed, SPEED_MIN, SPEED_MAX));
  if (volume !== undefined && Number.isFinite(volume)) next.volume = round3(clamp(volume, 0, VOLUME_MAX));
  if (muted !== undefined) next.muted = muted;
  for (const key of ["label", "note"] as const) {
    if (changes[key] === undefined) continue;
    if (changes[key]) next[key] = changes[key];
    else delete next[key];
  }
  return withMain(tl, tl.tracks.main.map((c) => (c.id === clipId ? next : c)));
}

/** Moves the clip at `from` so it plays just before the clip now at `before` (or last, if `before` is the length). */
export function moveClip(tl: Timeline, from: number, before: number): Timeline | null {
  const target = before > from ? before - 1 : before;
  if (target === from || from < 0 || from >= tl.tracks.main.length) return null;
  const main = [...tl.tracks.main];
  const [clip] = main.splice(from, 1);
  main.splice(clamp(target, 0, main.length), 0, clip);
  return withMain(tl, main);
}

/**
 * Removes the timeline range [from, to) across however many clips it touches.
 * Clips partly inside are trimmed; a clip containing the whole range becomes two.
 * Leftover pieces shorter than a frame are dropped.
 */
export function cutRange(tl: Timeline, from: number, to: number): Timeline | null {
  if (!(to > from)) return null;
  const ids = allClipIds(tl);
  const main: MainClip[] = [];
  let changed = false;
  for (const p of layoutMain(tl)) {
    const { clip } = p;
    if (to <= p.start || from >= p.end) {
      main.push(clip);
      continue;
    }
    changed = true;
    const min = minClipLength(tl, clip);
    const cutIn = round3(clip.in + (Math.max(from, p.start) - p.start) * p.speed);
    const cutOut = round3(clip.in + (Math.min(to, p.end) - p.start) * p.speed);
    const before = cutIn - clip.in >= min ? piece(tl, clip, clip.in, cutIn) : null;
    const after = clip.out - cutOut >= min ? piece(tl, clip, cutOut, clip.out) : null;
    if (before) main.push(before);
    if (after) {
      // When both halves survive, the second one is a new clip.
      const id = before ? nextId(ids, "c") : clip.id;
      ids.push(id);
      main.push({ ...after, id });
    }
  }
  return changed ? withMain(tl, main) : null;
}

/**
 * Removes a stretch of one source's time, [from, to), from every clip that plays it.
 * Used when words are deleted in the transcript. A clip containing the whole stretch
 * becomes two; leftover pieces shorter than a frame are dropped.
 */
export function cutSourceRange(tl: Timeline, sourceId: string, from: number, to: number): Timeline | null {
  if (!(to > from)) return null;
  const ids = allClipIds(tl);
  const main: MainClip[] = [];
  let changed = false;
  for (const clip of tl.tracks.main) {
    if (clip.sourceId !== sourceId || to <= clip.in || from >= clip.out) {
      main.push(clip);
      continue;
    }
    changed = true;
    const min = minClipLength(tl, clip);
    const before = round3(Math.max(from, clip.in)) - clip.in >= min ? { ...clip, out: round3(Math.max(from, clip.in)) } : null;
    const after = clip.out - round3(Math.min(to, clip.out)) >= min ? { ...clip, in: round3(Math.min(to, clip.out)) } : null;
    if (before) main.push(before);
    if (after) {
      const id = before ? nextId(ids, "c") : clip.id;
      ids.push(id);
      main.push({ ...after, id });
    }
  }
  return changed ? withMain(tl, main) : null;
}

// ---------------------------------------------------------------------------------
// Voice and music tracks. Their clips sit at an explicit timeline `start` and play at
// normal speed; they don't move when main-track clips are cut or reordered. Voice clips
// must not overlap: an edit that would make them overlap is refused (returns null).

export type AudioTrack = "voice" | "music";
type AudioClip = MusicClip | VoiceClip;

function audioClips(tl: Timeline, track: AudioTrack): AudioClip[] {
  return tl.tracks[track] ?? [];
}

function withAudio(tl: Timeline, track: AudioTrack, clips: AudioClip[]): Timeline {
  return { ...tl, tracks: { ...tl.tracks, [track]: clips } };
}

function audioClip(tl: Timeline, track: AudioTrack, id: string): AudioClip | undefined {
  return audioClips(tl, track).find((m) => m.id === id);
}

/** Replaces a clip, or returns null when that would make voice clips overlap. */
function replaceAudio(tl: Timeline, track: AudioTrack, next: AudioClip): Timeline | null {
  if (track === "voice" && voiceOverlap(tl, next)) return null;
  return withAudio(tl, track, audioClips(tl, track).map((m) => (m.id === next.id ? next : m)));
}

/** The voice clip that `clip` would overlap (touching is fine), if any. */
export function voiceOverlap(tl: Timeline, clip: AudioClip): VoiceClip | null {
  const end = clip.start + clip.out - clip.in;
  return (tl.tracks.voice ?? []).find((v) => v.id !== clip.id && clip.start < v.start + v.out - v.in - 1e-6 && v.start < end - 1e-6) ?? null;
}

/** Moves a voice or music clip to start at timeline time `start` (not before 0). */
export function moveAudio(tl: Timeline, track: AudioTrack, id: string, start: number): Timeline | null {
  const m = audioClip(tl, track, id);
  if (!m || !Number.isFinite(start)) return null;
  const next = round3(Math.max(0, start));
  return next === m.start ? null : replaceAudio(tl, track, { ...m, start: next });
}

/**
 * Moves a voice or music clip's in or out point. Moving `in` also moves `start`, so the
 * sound that stays keeps its place on the timeline (like trimming the left edge).
 */
export function trimAudio(tl: Timeline, track: AudioTrack, id: string, edge: "in" | "out", value: number): Timeline | null {
  const m = audioClip(tl, track, id);
  if (!m || !Number.isFinite(value)) return null;
  const min = 0.1;
  const sourceEnd = tl.sources.find((s) => s.id === m.sourceId)?.duration ?? Infinity;
  let next: AudioClip;
  if (edge === "in") {
    // Can't start before the source, before timeline 0, or within `min` of the out point.
    const newIn = round3(clamp(value, Math.max(0, m.in - m.start), m.out - min));
    next = { ...m, in: newIn, start: round3(m.start + (newIn - m.in)) };
  } else {
    next = { ...m, out: round3(clamp(value, m.in + min, sourceEnd)) };
  }
  next = clampFades(next);
  return next.in === m.in && next.out === m.out ? null : replaceAudio(tl, track, next);
}

export type AudioChanges = Partial<Pick<AudioClip, "volume" | "fadeIn" | "fadeOut" | "label" | "note">>;

/** Changes a voice or music clip's volume, fades, label or note. Fades are kept within the clip. */
export function updateAudio(tl: Timeline, track: AudioTrack, id: string, changes: AudioChanges): Timeline | null {
  const m = audioClip(tl, track, id);
  if (!m) return null;
  const next: AudioClip = { ...m };
  if (changes.volume !== undefined && Number.isFinite(changes.volume)) next.volume = round3(clamp(changes.volume, 0, VOLUME_MAX));
  for (const key of ["fadeIn", "fadeOut"] as const) {
    const v = changes[key];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v <= 0) delete next[key];
    else next[key] = round3(v);
  }
  for (const key of ["label", "note"] as const) {
    if (changes[key] === undefined) continue;
    if (changes[key]) next[key] = changes[key];
    else delete next[key];
  }
  return replaceAudio(tl, track, clampFades(next));
}

/** Fades can't be longer than the clip together. */
function clampFades<C extends AudioClip>(m: C): C {
  const length = m.out - m.in;
  const next = { ...m };
  if (next.fadeIn !== undefined) next.fadeIn = round3(Math.min(next.fadeIn, length));
  if (next.fadeOut !== undefined) next.fadeOut = round3(Math.min(next.fadeOut, length - (next.fadeIn ?? 0)));
  if (next.fadeOut !== undefined && next.fadeOut <= 0) delete next.fadeOut;
  return next;
}

/** Removes a voice or music clip. Nothing else moves. */
export function removeAudio(tl: Timeline, track: AudioTrack, id: string): Timeline | null {
  const clips = audioClips(tl, track);
  const next = clips.filter((m) => m.id !== id);
  return next.length === clips.length ? null : withAudio(tl, track, next);
}

/**
 * Removes a stretch of one source's time, [from, to), from every voice clip that plays
 * it (deleting words in a voiceover's transcript). The rest of that clip closes up the
 * gap, so the narration keeps flowing; other clips don't move. A clip containing the
 * whole stretch becomes two; leftover pieces shorter than 0.05 s are dropped.
 */
export function cutVoiceSourceRange(tl: Timeline, sourceId: string, from: number, to: number): Timeline | null {
  if (!(to > from)) return null;
  const min = 0.05;
  const ids = allClipIds(tl);
  const voice: VoiceClip[] = [];
  let changed = false;
  for (const clip of tl.tracks.voice ?? []) {
    if (clip.sourceId !== sourceId || to <= clip.in || from >= clip.out) {
      voice.push(clip);
      continue;
    }
    changed = true;
    const cutIn = round3(Math.max(from, clip.in));
    const cutOut = round3(Math.min(to, clip.out));
    const keepBefore = cutIn - clip.in >= min;
    const keepAfter = clip.out - cutOut >= min;
    if (keepBefore) {
      // The first part keeps the id, label, note and fade-in; the fade-out goes with the last part.
      const before: VoiceClip = { ...clip, out: cutIn };
      if (keepAfter) delete before.fadeOut;
      voice.push(clampFades(before));
    }
    if (keepAfter) {
      const after: VoiceClip = { ...clip, in: cutOut };
      if (keepBefore) {
        // A new clip that starts where the first part ends.
        after.id = nextId(ids, "v");
        ids.push(after.id);
        after.start = round3(clip.start + cutIn - clip.in);
        delete after.fadeIn;
        delete after.label;
        delete after.note;
      }
      voice.push(clampFades(after));
    }
  }
  return changed ? withAudio(tl, "voice", voice) : null;
}

/** Sets how many dB music is lowered under voice (0 turns ducking off). */
export function setDucking(tl: Timeline, db: number): Timeline | null {
  if (!Number.isFinite(db)) return null;
  const next = round3(clamp(db, MAX_DUCK_DB, 0));
  if (next === (tl.tracks.mix?.duckMusicUnderVoice ?? 0)) return null;
  const tracks = { ...tl.tracks };
  if (next === 0) delete tracks.mix;
  else tracks.mix = { ...tl.tracks.mix, duckMusicUnderVoice: next };
  return { ...tl, tracks };
}
