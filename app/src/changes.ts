// Describes what changed between two versions of a timeline, in short sentences with
// timeline timecodes. Used for the "Timeline updated externally" message.

import { layoutMain, totalDuration, type PlacedClip } from "../../schema/sequence.ts";
import { formatTimecode } from "../../schema/timecode.ts";
import type { MusicClip, Timeline, VoiceClip } from "../../schema/timeline.ts";

const MAX_LINES = 8;

export function summarizeChanges(before: Timeline, after: Timeline): string[] {
  const fps = after.fps ?? before.fps ?? 25;
  const tc = (t: number) => formatTimecode(t, fps);
  const secs = (p: PlacedClip) => `${(p.end - p.start).toFixed(1)} s`;
  const name = (p: PlacedClip) => (p.clip.label ? `${p.clip.id} "${p.clip.label}"` : p.clip.id);
  const pct = (v: number | undefined) => `${Math.round((v ?? 1) * 100)}%`;

  const old = layoutMain(before);
  const now = layoutMain(after);
  const oldById = new Map(old.map((p) => [p.clip.id, p]));
  const nowById = new Map(now.map((p) => [p.clip.id, p]));
  const lines: string[] = [];

  for (const p of now) if (!oldById.has(p.clip.id)) lines.push(`Added ${name(p)} at ${tc(p.start)} (${secs(p)})`);
  for (const p of old) if (!nowById.has(p.clip.id)) lines.push(`Removed ${name(p)} (was at ${tc(p.start)}, ${secs(p)})`);

  for (const p of now) {
    const o = oldById.get(p.clip.id);
    if (!o) continue;
    const c = p.clip;
    const b = o.clip;
    const at = `at ${tc(p.start)}`;
    const trims: string[] = [];
    if (c.in !== b.in) trims.push(`in ${b.in.toFixed(3)} → ${c.in.toFixed(3)} s`);
    if (c.out !== b.out) trims.push(`out ${b.out.toFixed(3)} → ${c.out.toFixed(3)} s`);
    if (c.sourceId !== b.sourceId) trims.push(`source ${b.sourceId} → ${c.sourceId}`);
    if (trims.length) lines.push(`Trimmed ${name(p)} ${at}: ${trims.join(", ")}`);
    if ((c.speed ?? 1) !== (b.speed ?? 1)) lines.push(`Speed of ${name(p)} ${at}: ${b.speed ?? 1}× → ${c.speed ?? 1}×`);
    if ((c.volume ?? 1) !== (b.volume ?? 1)) lines.push(`Volume of ${name(p)} ${at}: ${pct(b.volume)} → ${pct(c.volume)}`);
    if ((c.muted ?? false) !== (b.muted ?? false)) lines.push(`${c.muted ? "Muted" : "Unmuted"} ${name(p)} ${at}`);
    if ((c.fit ?? "contain") !== (b.fit ?? "contain")) lines.push(`Fit of ${name(p)} ${at}: ${b.fit ?? "contain"} → ${c.fit ?? "contain"}`);
    if (JSON.stringify(c.zoom ?? null) !== JSON.stringify(b.zoom ?? null)) {
      const describe = (z: typeof c.zoom) => (z ? `${z.from}×–${z.to}×` : "none");
      lines.push(`Zoom of ${name(p)} ${at}: was ${describe(b.zoom)}, now ${describe(c.zoom)}`);
    }
    if ((c.label ?? "") !== (b.label ?? "")) {
      lines.push(c.label ? `Label of ${c.id} ${at} set to "${c.label}"` : `Label "${b.label}" removed from ${c.id} ${at}`);
    }
    if ((c.note ?? "") !== (b.note ?? "")) lines.push(c.note ? `Note on ${name(p)} ${at}: "${c.note}"` : `Note removed from ${name(p)} ${at}`);
  }

  // Same clips, different order?
  const keptOld = old.map((p) => p.clip.id).filter((id) => nowById.has(id));
  const keptNow = now.map((p) => p.clip.id).filter((id) => oldById.has(id));
  if (keptOld.join("\n") !== keptNow.join("\n")) lines.push("Clips reordered");

  const oldSources = new Map(before.sources.map((s) => [s.id, s]));
  const nowSources = new Map(after.sources.map((s) => [s.id, s]));
  for (const s of after.sources) if (!oldSources.has(s.id)) lines.push(`Added source ${s.id} (${s.path})`);
  for (const s of before.sources) if (!nowSources.has(s.id)) lines.push(`Removed source ${s.id} (${s.path})`);
  lines.push(...audioChanges(before, after, "voice", tc));
  lines.push(...audioChanges(before, after, "music", tc));
  const oldDb = before.tracks.mix?.duckMusicUnderVoice ?? 0;
  const newDb = after.tracks.mix?.duckMusicUnderVoice ?? 0;
  if (oldDb !== newDb) lines.push(newDb ? `Music under voice lowered by ${-newDb} dB (was ${oldDb ? `${-oldDb} dB` : "off"})` : "Music no longer lowered under voice");
  if (before.fps !== after.fps || JSON.stringify(before.resolution) !== JSON.stringify(after.resolution)) {
    lines.push("Project frame rate or resolution changed");
  }

  const oldTotal = totalDuration(old);
  const newTotal = totalDuration(now);
  if (lines.length === 0 && oldTotal === newTotal) return ["No changes to the edit (only formatting)."];

  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `…and ${lines.length - MAX_LINES + 1} more changes`] : lines;
  if (Math.abs(oldTotal - newTotal) > 0.0005) shown.push(`Length ${tc(oldTotal)} → ${tc(newTotal)}`);
  return shown;
}

function audioChanges(before: Timeline, after: Timeline, track: "voice" | "music", tc: (t: number) => string): string[] {
  const old = new Map<string, MusicClip | VoiceClip>((before.tracks[track] ?? []).map((m) => [m.id, m]));
  const now = after.tracks[track] ?? [];
  const what = track === "voice" ? "voiceover" : "music";
  const name = (m: MusicClip | VoiceClip) => `${what} ${m.label ? `${m.id} "${m.label}"` : m.id}`;
  const lines: string[] = [];
  for (const m of now) {
    const b = old.get(m.id);
    if (!b) {
      lines.push(`Added ${name(m)} at ${tc(m.start)} (${(m.out - m.in).toFixed(1)} s)`);
      continue;
    }
    // Trimming the left edge moves in and start together; that's a trim, not a move.
    const leftTrim = m.in - b.in === m.start - b.start;
    if (m.start !== b.start && !leftTrim) lines.push(`Moved ${name(m)}: ${tc(b.start)} → ${tc(m.start)}`);
    if (m.in !== b.in || m.out !== b.out) lines.push(`Trimmed ${name(m)} at ${tc(m.start)}: ${(b.out - b.in).toFixed(1)} → ${(m.out - m.in).toFixed(1)} s`);
    if ((m.volume ?? 1) !== (b.volume ?? 1)) lines.push(`Volume of ${name(m)}: ${Math.round((b.volume ?? 1) * 100)}% → ${Math.round((m.volume ?? 1) * 100)}%`);
    if ((m.fadeIn ?? 0) !== (b.fadeIn ?? 0) || (m.fadeOut ?? 0) !== (b.fadeOut ?? 0)) {
      lines.push(`Fades of ${name(m)}: in ${m.fadeIn ?? 0} s, out ${m.fadeOut ?? 0} s`);
    }
    if ((m.label ?? "") !== (b.label ?? "") || (m.note ?? "") !== (b.note ?? "")) lines.push(`Label or note of ${what} ${m.id} changed`);
  }
  for (const b of old.values()) if (!now.some((m) => m.id === b.id)) lines.push(`Removed ${name(b)} (was at ${tc(b.start)})`);
  return lines;
}
