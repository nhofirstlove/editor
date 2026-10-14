// Text output for the CLI. Plain ASCII, so it reads the same in any terminal.

import { layoutMain, totalDuration } from "../schema/sequence.ts";
import { formatTimecode } from "../schema/timecode.ts";
import { isImage, type Timeline } from "../schema/timeline.ts";

const DEFAULT_FPS = 25;

/** "46.480 s (00:00:46:12)" */
export function describeDuration(seconds: number, fps: number): string {
  return `${seconds.toFixed(3)} s (${formatTimecode(seconds, fps)})`;
}

export function formatDuration(tl: Timeline): string {
  const fps = tl.fps ?? DEFAULT_FPS;
  const n = tl.tracks.main.length;
  return `${describeDuration(totalDuration(layoutMain(tl)), fps)}, ${n} clip${n === 1 ? "" : "s"}`;
}

/** A readable table of the main track with source and timeline times, plus sources, voiceover and music. */
export function formatSummary(tl: Timeline, projectName: string): string {
  const fps = tl.fps ?? DEFAULT_FPS;
  const placed = layoutMain(tl);
  const lines: string[] = [
    `Project ${projectName} | ${placed.length} clip${placed.length === 1 ? "" : "s"} | ${fps} fps | total ${describeDuration(totalDuration(placed), fps)}`,
    "",
    "Main track (in/out are source seconds; start/end are timeline seconds):",
  ];

  if (placed.length === 0) {
    lines.push("  (empty)");
  } else {
    const rows = placed.map((p, i) => {
      const c = p.clip;
      const still = isImage(tl.sources.find((s) => s.id === c.sourceId));
      const flags = [
        still ? "still image" : "",
        c.zoom ? `zoom ${c.zoom.from}x->${c.zoom.to}x` : "",
        c.fit === "cover" ? "fit: cover" : "",
        c.muted ? "muted" : "",
        c.note ? `note: "${truncate(c.note, 50)}"` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return [
        String(i + 1),
        c.id,
        truncate(c.label ?? "", 24),
        c.sourceId,
        c.in.toFixed(3),
        c.out.toFixed(3),
        p.start.toFixed(3),
        p.end.toFixed(3),
        formatTimecode(p.start, fps),
        still ? "-" : `${c.speed ?? 1}x`,
        still ? "-" : `${Math.round((c.volume ?? 1) * 100)}%`,
        flags,
      ];
    });
    const header = ["#", "id", "label", "source", "in", "out", "start", "end", "start TC", "speed", "volume", "flags"];
    lines.push(...table([header, ...rows]).map((l) => `  ${l}`));
  }

  lines.push("", "Sources:");
  if (tl.sources.length === 0) lines.push("  (none)");
  for (const s of tl.sources) {
    const details = [
      isImage(s) ? "still image" : s.duration !== undefined ? `${s.duration.toFixed(3)} s` : "length unknown",
      s.fps ? `${s.fps} fps` : "",
      s.width && s.height ? `${s.width}x${s.height}` : "",
      s.audioChannels === 0 ? "no audio" : "",
    ].filter(Boolean);
    lines.push(`  ${s.id}  ${s.path}  (${details.join(", ")})`);
  }

  for (const [track, title] of [
    ["voice", "Voiceover track"],
    ["music", "Music track"],
  ] as const) {
    const clips = tl.tracks[track] ?? [];
    if (!clips.length) continue;
    lines.push("", `${title} (start/end are timeline seconds; in/out are source seconds):`);
    const rows = clips.map((m) => [
      m.id,
      m.sourceId,
      m.start.toFixed(3),
      (m.start + m.out - m.in).toFixed(3),
      m.in.toFixed(3),
      m.out.toFixed(3),
      `${Math.round((m.volume ?? 1) * 100)}%`,
      truncate(m.label ?? "", 30),
    ]);
    lines.push(...table([["id", "source", "start", "end", "in", "out", "volume", "label"], ...rows]).map((l) => `  ${l}`));
  }
  const db = tl.tracks.mix?.duckMusicUnderVoice ?? 0;
  if (db) lines.push("", `Music is lowered by ${-db} dB while a voiceover clip plays.`);
  return lines.join("\n");
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/** The summary as data, for --json: every clip with its source and timeline times. */
export function summaryData(tl: Timeline, projectName: string) {
  const placed = layoutMain(tl);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    project: projectName,
    version: tl.version,
    fps: tl.fps ?? DEFAULT_FPS,
    resolution: tl.resolution ?? null,
    duration: round(totalDuration(placed)),
    main: placed.map((p) => ({
      id: p.clip.id,
      label: p.clip.label ?? null,
      sourceId: p.clip.sourceId,
      in: p.clip.in,
      out: p.clip.out,
      start: round(p.start),
      end: round(p.end),
      speed: p.speed,
      volume: p.clip.volume ?? 1,
      muted: p.clip.muted ?? false,
      note: p.clip.note ?? null,
    })),
    voice: tl.tracks.voice ?? [],
    music: tl.tracks.music ?? [],
    duckMusicUnderVoice: tl.tracks.mix?.duckMusicUnderVoice ?? 0,
    sources: tl.sources,
  };
}
