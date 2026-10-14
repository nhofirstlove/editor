// transcript.json: the words spoken in each source, with timestamps in SOURCE seconds.
// It is generated (by faster-whisper) and only read by the editor and CLI; edits happen
// in timeline.json. These helpers place words on the timeline using the same timing
// rules as the player and export.

import { z } from "zod";
import type { PlacedClip } from "./sequence.ts";

const seconds = z.number().min(0);

export const wordSchema = z.strictObject({
  text: z.string(),
  start: seconds,
  end: seconds,
  /** How sure the speech model was, 0..1. */
  probability: z.number().min(0).max(1).optional(),
});

export const sourceTranscriptSchema = z.strictObject({
  /** The media file this was made from; a transcript for a different file is ignored. */
  path: z.string(),
  model: z.string(),
  language: z.string().optional(),
  createdAt: z.string(),
  words: z.array(wordSchema),
});

export const transcriptSchema = z.strictObject({
  version: z.literal(1).optional(),
  /** By source id. */
  sources: z.record(z.string(), sourceTranscriptSchema).optional(),
});

export type Word = z.infer<typeof wordSchema>;
export type SourceTranscript = z.infer<typeof sourceTranscriptSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;

export function parseTranscriptJson(text: string): { ok: true; transcript: Transcript } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, error: `transcript.json is not valid JSON (${(e as Error).message}).` };
  }
  const result = transcriptSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: `transcript.json doesn't have the expected shape (at ${first.path.join(".") || "the top"}: ${first.message}).` };
  }
  return { ok: true, transcript: result.data };
}

/** The words for a source, if there is a transcript of the file it points to now. */
export function wordsFor(transcript: Transcript | null, sourceId: string, sourcePath: string): Word[] | null {
  const t = transcript?.sources?.[sourceId];
  return t && t.path === sourcePath ? t.words : null;
}

/** A word counts as in a clip when its middle is inside the clip's in–out range. */
function middle(w: Word): number {
  return (w.start + w.end) / 2;
}

/** The first clip that plays this word, or null if the word has been cut. */
export function clipPlaying(placed: PlacedClip[], sourceId: string, w: Word): PlacedClip | null {
  const m = middle(w);
  return placed.find((p) => p.clip.sourceId === sourceId && m >= p.clip.in && m < p.clip.out) ?? null;
}

/** Timeline time at which a word starts, or null if it has been cut. */
export function wordTimelineStart(placed: PlacedClip[], sourceId: string, w: Word): number | null {
  const p = clipPlaying(placed, sourceId, w);
  return p ? p.start + (Math.max(w.start, p.clip.in) - p.clip.in) / p.speed : null;
}

export type TimelineWord = Word & {
  sourceId: string;
  clipId: string;
  /** Timeline seconds. */
  timelineStart: number;
  timelineEnd: number;
};

/** Every word that plays in the edit, in playback order, with timeline times. */
export function wordsOnTimeline(placed: PlacedClip[], wordsBySource: Record<string, Word[] | null>): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (const p of placed) {
    const { clip } = p;
    for (const w of wordsBySource[clip.sourceId] ?? []) {
      const m = middle(w);
      if (m < clip.in || m >= clip.out) continue;
      const toTimeline = (s: number) => p.start + (Math.min(Math.max(s, clip.in), clip.out) - clip.in) / p.speed;
      out.push({ ...w, sourceId: clip.sourceId, clipId: clip.id, timelineStart: toTimeline(w.start), timelineEnd: toTimeline(w.end) });
    }
  }
  return out;
}

/**
 * Index of the word being spoken at a source time: the last word that has started,
 * kept until the next word starts (or up to a second after it ends). -1 if none.
 */
export function wordIndexAt(words: Word[], sourceTime: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= sourceTime) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found === -1) return -1;
  const until = Math.min(words[found + 1]?.start ?? Infinity, words[found].end + 1);
  return sourceTime < until ? found : -1;
}
