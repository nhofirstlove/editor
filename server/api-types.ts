// Shapes of the API responses, shared with the browser app (no Node imports here).

import type { Timeline } from "../schema/timeline.ts";

export type FileStatus = {
  status: "ready" | "queued" | "running" | "failed" | "missing-source" | "no-audio" | "not-started";
  /** 0..1 */
  progress: number;
  error?: string;
  /** A message from the running job, e.g. "using the processor instead". */
  note?: string;
  /** Where to fetch the file once it's ready. */
  url?: string;
};

export type MediaStatus = {
  proxy: FileStatus;
  peaks: FileStatus;
  /** Transcription only runs when asked for; "not-started" until then. */
  transcript: FileStatus;
};

export type ProjectResponse = {
  name: string;
  /** The last valid timeline. Shown even while the file on disk has errors. */
  timeline: Timeline | null;
  /** Identifies the exact version of timeline.json on disk (null if it can't be read). */
  revision: string | null;
  /** Problems with timeline.json on disk; empty when it's valid. */
  errors: string[];
  /** Proxy and waveform status for each source id. */
  media: Record<string, MediaStatus>;
};

export type HealthResponse = {
  tools: { ok: true } | { ok: false; message: string };
  /** Whether Python with faster-whisper is available for transcription. */
  transcriber: { ok: true } | { ok: false; message: string };
};

/** Contents of peaks/<name>.peaks.json. */
export type PeaksFile = {
  version: 1;
  /** How many peak values there are per second of source time. */
  peaksPerSecond: number;
  /** Loudest sample in each slice, 0 (silent) to 255 (full scale). */
  peaks: number[];
};

/** One export in a project's exports/ folder (or still being rendered). */
export type ExportInfo = {
  /** Base file name, e.g. "AI_preview_2026-10-14_09-30-05". */
  name: string;
  /** "resolve" is an .otio hand-off file for DaVinci Resolve. */
  preset: "final" | "preview" | "resolve" | null;
  status: "queued" | "running" | "ready" | "failed";
  /** 0..1 */
  progress: number;
  error?: string;
  /** The video, once it's ready. */
  url?: string;
  /** The saved ffmpeg command. */
  commandUrl?: string;
  /** File size in bytes, once ready. */
  size?: number;
  /** Length of the rendered video in seconds, once ready. */
  duration?: number;
  /** When the export was started or the file last written (ms since 1970). */
  createdAt: number;
};
