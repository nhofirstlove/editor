// How a timeline plays: where each main-track clip sits in timeline time, and how
// timeline time maps to source time. The player, the timeline UI, the CLI and the
// export all use these functions, so they interpret the file identically.

import type { MainClip, MusicClip, Timeline, VoiceClip } from "./timeline.ts";

export type PlacedClip = {
  clip: MainClip;
  index: number;
  /** Timeline time where the clip starts. */
  start: number;
  /** Timeline time where the clip ends. */
  end: number;
  speed: number;
};

/** Main-track clips play back-to-back in array order. */
export function layoutMain(tl: Timeline): PlacedClip[] {
  const placed: PlacedClip[] = [];
  let start = 0;
  tl.tracks.main.forEach((clip, index) => {
    const speed = clip.speed ?? 1;
    const end = start + (clip.out - clip.in) / speed;
    placed.push({ clip, index, start, end, speed });
    start = end;
  });
  return placed;
}

export function totalDuration(placed: PlacedClip[]): number {
  return placed.length ? placed[placed.length - 1].end : 0;
}

/**
 * The clip playing at timeline time `t`, and the source time shown there.
 * At an exact cut the later clip wins; at the very end the last clip's final moment is used.
 */
export function locate(placed: PlacedClip[], t: number): { placed: PlacedClip; sourceTime: number } | null {
  if (!placed.length || t < 0) return null;
  let hit = placed.find((p) => t >= p.start && t < p.end);
  if (!hit) {
    const last = placed[placed.length - 1];
    if (t > last.end + 1e-9) return null;
    hit = last;
  }
  return { placed: hit, sourceTime: Math.min(hit.clip.out, hit.clip.in + (t - hit.start) * hit.speed) };
}

/** Timeline time at which `sourceTime` inside a placed clip is shown. */
export function timelineTimeOf(p: PlacedClip, sourceTime: number): number {
  return p.start + (sourceTime - p.clip.in) / p.speed;
}

/**
 * Loudness (0..volume) of a music clip at `local` seconds after its start, with linear
 * fade-in and fade-out, the same shape as ffmpeg's afade used by the export. 0 outside the clip.
 */
export function musicGainAt(m: MusicClip, local: number): number {
  const length = m.out - m.in;
  if (local < 0 || local >= length) return 0;
  let gain = m.volume ?? 1;
  if (m.fadeIn && local < m.fadeIn) gain *= local / m.fadeIn;
  if (m.fadeOut && local > length - m.fadeOut) gain *= (length - local) / m.fadeOut;
  return gain;
}

/**
 * Voice clips as placed clips (normal speed, at their own start), sorted by start, so
 * transcript words can be placed on the timeline with the same helpers as the main track.
 */
export function layoutVoice(tl: Timeline): PlacedClip[] {
  return (tl.tracks.voice ?? [])
    .map((clip, index) => ({ clip, index, start: clip.start, end: clip.start + clip.out - clip.in, speed: 1 }))
    .sort((a, b) => a.start - b.start);
}

/** The voice clip playing at timeline time `t`, and the source time heard there. */
export function locateVoice(voice: PlacedClip[], t: number): { placed: PlacedClip; sourceTime: number } | null {
  const hit = voice.find((p) => t >= p.start && t < p.end);
  return hit ? { placed: hit, sourceTime: hit.clip.in + (t - hit.start) } : null;
}

/** Seconds music takes to go down before a voice clip and back up after it. */
export const DUCK_RAMP = 0.25;

export type DuckSpan = { from: number; to: number };

/** Where voice clips play (timeline seconds), sorted. Ducking follows these positions, not the sound. */
export function voiceSpans(voice: VoiceClip[] | undefined): DuckSpan[] {
  return (voice ?? [])
    .map((v) => ({ from: v.start, to: v.start + v.out - v.in }))
    .sort((a, b) => a.from - b.from);
}

/** The music-ducking setting in dB (0 = off). */
export function duckDb(tl: Timeline): number {
  return tl.tracks.mix?.duckMusicUnderVoice ?? 0;
}

/**
 * How far music is lowered at timeline time `t`, from 0 (not at all) to 1 (the full
 * amount): 1 while a voice clip plays, ramping linearly over DUCK_RAMP before and after.
 * The export builds the same shape as an ffmpeg expression (duckExpression in server/export.ts).
 */
export function duckDepthAt(spans: DuckSpan[], t: number): number {
  let depth = 0;
  for (const s of spans) {
    const d = clamp01((t - (s.from - DUCK_RAMP)) / DUCK_RAMP) * clamp01((s.to + DUCK_RAMP - t) / DUCK_RAMP);
    if (d > depth) depth = d;
  }
  return depth;
}

/** Factor music is multiplied by at timeline time `t`: 10^(dB × depth / 20). 1 when ducking is off. */
export function duckGainAt(spans: DuckSpan[], db: number, t: number): number {
  if (!db) return 1;
  const depth = duckDepthAt(spans, t);
  return depth ? Math.pow(10, (db * depth) / 20) : 1;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Scale of an image clip's zoom at `local` seconds into the clip: linear from
 * zoom.from to zoom.to over the clip. 1 when the clip has no zoom.
 */
export function zoomAt(clip: MainClip, local: number): number {
  const zoom = clip.zoom;
  if (!zoom) return 1;
  const length = clip.out - clip.in;
  const k = length > 0 ? clamp01(local / length) : 0;
  return zoom.from + (zoom.to - zoom.from) * k;
}

/**
 * The part of the fitted frame that is visible at `local` seconds, as fractions of the
 * frame: the picture is scaled by `scale` around the focus point (which stays put), the
 * same as a CSS transform with transform-origin at the focus. The export crops exactly
 * this window (zoomCorners in server/export.ts).
 */
export function zoomWindow(clip: MainClip, local: number): { scale: number; left: number; top: number; width: number; height: number } {
  const scale = zoomAt(clip, local);
  const fx = clip.zoom?.focus?.x ?? 0.5;
  const fy = clip.zoom?.focus?.y ?? 0.5;
  return { scale, left: fx * (1 - 1 / scale), top: fy * (1 - 1 / scale), width: 1 / scale, height: 1 / scale };
}
