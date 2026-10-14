// Hand-off to DaVinci Resolve (or any editor that reads OpenTimelineIO): writes the
// timeline as an .otio file. Clips point to the original files in media/ by full path,
// so Resolve can link them. Times are whole frames at the timeline's frame rate; clip
// boundaries are rounded from the running timeline position, so rounding never drifts.
//
// What carries over: clip order and cut points, speed (as an OTIO LinearTimeWarp), the
// voiceover and music tracks, labels as clip names, still images (as clips of the image
// file, with fit and zoom in metadata: Resolve shows them without the zoom). Volume, mute and notes are kept in each clip's
// metadata (and music ducking in the timeline's), but Resolve doesn't apply them; set
// levels in Resolve's mixer.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { layoutMain, totalDuration } from "../schema/sequence.ts";
import { hasAudio, isImage, type MusicClip, type Source, type Timeline, type VoiceClip } from "../schema/timeline.ts";
import { localStamp } from "./history.ts";
import { exists } from "./projects.ts";

type Json = Record<string, unknown>;

export function buildOtio(tl: Timeline, projectDir: string, exportedAt = new Date()): Json {
  const fps = tl.fps ?? 25;
  const frames = (seconds: number) => Math.round(seconds * fps);
  const time = (frameCount: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate: fps, value: frameCount });
  const range = (start: number, duration: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: time(start), duration: time(duration) });
  const sources = new Map(tl.sources.map((s) => [s.id, s]));

  const reference = (s: Source): Json => ({
    OTIO_SCHEMA: "ExternalReference.1",
    name: path.basename(s.path),
    target_url: pathToFileURL(path.join(projectDir, s.path)).href,
    available_range: s.duration !== undefined ? range(0, frames(s.duration)) : null,
    available_image_bounds: null,
    metadata: {},
  });
  const clip = (name: string, s: Source, sourceStart: number, duration: number, effects: Json[], metadata: Json): Json => ({
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(sourceStart, duration),
    effects,
    markers: [],
    enabled: true,
    metadata: { "text-video-editor": metadata },
    media_references: { DEFAULT_MEDIA: reference(s) },
    active_media_reference_key: "DEFAULT_MEDIA",
  });
  const gap = (duration: number): Json => ({
    OTIO_SCHEMA: "Gap.1",
    name: "",
    source_range: range(0, duration),
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  });
  const track = (name: string, kind: "Video" | "Audio", children: Json[]): Json => ({
    OTIO_SCHEMA: "Track.1",
    name,
    kind,
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
    children,
  });

  // Main track: picture, plus its sound on an audio track (gaps where it's silent).
  const video: Json[] = [];
  const audio: Json[] = [];
  for (const p of layoutMain(tl)) {
    const c = p.clip;
    const s = sources.get(c.sourceId)!;
    const duration = frames(p.end) - frames(p.start);
    if (duration <= 0) continue;
    const effects =
      p.speed !== 1 ? [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "speed", effect_name: "LinearTimeWarp", metadata: {}, time_scalar: p.speed }] : [];
    const metadata = {
      id: c.id,
      speed: p.speed,
      volume: c.volume ?? 1,
      muted: c.muted ?? false,
      ...(c.fit ? { fit: c.fit } : {}),
      ...(isImage(s) ? { still: true, ...(c.zoom ? { zoom: c.zoom } : {}) } : {}),
      ...(c.note ? { note: c.note } : {}),
    };
    const name = c.label ?? c.id;
    video.push(clip(name, s, frames(c.in), duration, effects, metadata));
    audio.push(c.muted || !hasAudio(s) ? gap(duration) : clip(name, s, frames(c.in), duration, effects, metadata));
  }

  // Voiceover, then music: overlapping clips go on separate tracks (voice clips never
  // overlap, so the voiceover is one track). Like the export, they stop where the main
  // track ends. "Voiceover" comes first so Resolve shows it above "Music".
  const end = frames(totalDuration(layoutMain(tl)));
  const placedTracks = (name: string, clips: (MusicClip | VoiceClip)[]) => {
    const lanes: (MusicClip | VoiceClip)[][] = [];
    for (const m of [...clips].sort((a, b) => a.start - b.start)) {
      if (frames(m.start) >= end) continue;
      const lane = lanes.find((l) => {
        const last = l[l.length - 1];
        return frames(last.start + last.out - last.in) <= frames(m.start);
      });
      if (lane) lane.push(m);
      else lanes.push([m]);
    }
    return lanes.map((lane, i) => {
      const children: Json[] = [];
      let at = 0;
      for (const m of lane) {
        const start = frames(m.start);
        if (start > at) children.push(gap(start - at));
        const duration = Math.min(frames(m.start + m.out - m.in), end) - start;
        const metadata = { id: m.id, volume: m.volume ?? 1, fadeIn: m.fadeIn ?? 0, fadeOut: m.fadeOut ?? 0, ...(m.note ? { note: m.note } : {}) };
        children.push(clip(m.label ?? m.id, sources.get(m.sourceId)!, frames(m.in), duration, [], metadata));
        at = start + duration;
      }
      return track(lanes.length > 1 ? `${name} ${i + 1}` : name, "Audio", children);
    });
  };
  const audioTracks = [...placedTracks("Voiceover", tl.tracks.voice ?? []), ...placedTracks("Music", tl.tracks.music ?? [])];

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: tl.project ?? path.basename(projectDir),
    global_start_time: time(0),
    metadata: {
      "text-video-editor": { exportedAt: exportedAt.toISOString(), fps, resolution: tl.resolution ?? null, duckMusicUnderVoice: tl.tracks.mix?.duckMusicUnderVoice ?? 0 },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      metadata: {},
      children: [track("Video 1", "Video", video), track("Audio 1", "Audio", audio), ...audioTracks],
    },
  };
}

/** Writes exports/<project>_resolve_<time>.otio and returns its file name. */
export async function writeOtio(projectDir: string, tl: Timeline, now = new Date()): Promise<string> {
  if (tl.tracks.main.length === 0) throw new Error("There is nothing to hand off yet: the timeline has no clips.");
  const project = (tl.project ?? path.basename(projectDir)).replace(/[^A-Za-z0-9_-]+/g, "_");
  const base = `${project}_resolve_${localStamp(now)}`;
  await mkdir(path.join(projectDir, "exports"), { recursive: true });
  for (let n = 1; ; n++) {
    const file = `${n === 1 ? base : `${base}-${n}`}.otio`;
    if (await exists(path.join(projectDir, "exports", file))) continue;
    await writeFile(path.join(projectDir, "exports", file), JSON.stringify(buildOtio(tl, projectDir, now), null, 2) + "\n");
    return file;
  }
}
