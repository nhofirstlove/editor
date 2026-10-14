// Milestone 8: the voiceover track and music ducking, below the level of a real export
// (tests/e2e.test.ts measures the exported sound).

import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cutVoiceSourceRange, moveAudio, removeAudio, setDucking, trimAudio, updateAudio, voiceOverlap } from "../app/src/edits.ts";
import { summarizeChanges } from "../app/src/changes.ts";
import { DUCK_RAMP, duckDepthAt, duckGainAt, layoutVoice, locateVoice, voiceSpans } from "../schema/sequence.ts";
import { allClipIds, validateTimeline, type Timeline, type VoiceClip } from "../schema/timeline.ts";
import { wordsOnTimeline } from "../schema/transcript.ts";
import { buildExport, duckExpression } from "../server/export.ts";
import { buildOtio, writeOtio } from "../server/handoff.ts";
import { addImportedSource } from "../server/projects.ts";

const tl: Timeline = {
  version: 2,
  project: "demo",
  fps: 25,
  sources: [
    { id: "src1", path: "media/shot.mp4", duration: 20, fps: 25, width: 1280, height: 720, audioChannels: 2 },
    { id: "vo", path: "media/voiceover.wav", duration: 30, audioChannels: 1 },
    { id: "bed", path: "media/bed.mp3", duration: 60, audioChannels: 2 },
  ],
  tracks: {
    main: [{ id: "c1", sourceId: "src1", in: 0, out: 20 }],
    voice: [
      { id: "v1", sourceId: "vo", start: 1, in: 0, out: 5, label: "Intro" }, // 1–6
      { id: "v2", sourceId: "vo", start: 8, in: 10, out: 14 }, //             8–12
    ],
    music: [{ id: "m1", sourceId: "bed", start: 0, in: 0, out: 20, volume: 0.3 }],
    mix: { duckMusicUnderVoice: -12 },
  },
};
const voiceOf = (t: Timeline | null) => t!.tracks.voice!;

describe("timeline format: voice track and mix", () => {
  it("accepts a voice track and ducking setting", () => {
    expect(validateTimeline(tl).ok).toBe(true);
    expect(allClipIds(tl)).toEqual(["c1", "v1", "v2", "m1"]);
  });

  it("refuses overlapping voice clips, but allows touching ones", () => {
    const touching = { ...tl, tracks: { ...tl.tracks, voice: [...voiceOf(tl), { id: "v3", sourceId: "vo", start: 12, in: 0, out: 1 }] } };
    expect(validateTimeline(touching).ok).toBe(true);
    const overlapping = { ...tl, tracks: { ...tl.tracks, voice: [...voiceOf(tl), { id: "v3", sourceId: "vo", start: 11.5, in: 0, out: 1 }] } };
    const result = validateTimeline(overlapping);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      'tracks.voice[2] (clip "v3"): "start" (11.5) overlaps voice clip "v2", which plays until 12; voice clips must not overlap',
    ]);
  });

  it("checks the ducking range and voice clip ids", () => {
    const loud = validateTimeline({ ...tl, tracks: { ...tl.tracks, mix: { duckMusicUnderVoice: -40 } } });
    expect(!loud.ok && loud.errors[0]).toMatch(/duckMusicUnderVoice" must be between -30 and 0/);
    const clash = validateTimeline({ ...tl, tracks: { ...tl.tracks, voice: [{ ...voiceOf(tl)[0], id: "c1" }] } });
    expect(!clash.ok && clash.errors[0]).toMatch(/"c1" is used by more than one clip/);
  });
});

describe("ducking curve (shared by the player and the export)", () => {
  const spans = voiceSpans(tl.tracks.voice);

  it("follows the voice clips' positions, ramping over 0.25 s each side", () => {
    expect(spans).toEqual([
      { from: 1, to: 6 },
      { from: 8, to: 12 },
    ]);
    expect(DUCK_RAMP).toBe(0.25);
    expect(duckDepthAt(spans, 0.5)).toBe(0);
    expect(duckDepthAt(spans, 0.875)).toBeCloseTo(0.5, 9);
    expect(duckDepthAt(spans, 1)).toBe(1);
    expect(duckDepthAt(spans, 6)).toBe(1);
    expect(duckDepthAt(spans, 6.125)).toBeCloseTo(0.5, 9);
    expect(duckDepthAt(spans, 7)).toBe(0);
  });

  it("lowers music by the setting in dB, and not at all when it's off", () => {
    expect(20 * Math.log10(duckGainAt(spans, -12, 3))).toBeCloseTo(-12, 9);
    expect(20 * Math.log10(duckGainAt(spans, -12, 0.875))).toBeCloseTo(-6, 9);
    expect(duckGainAt(spans, -12, 7)).toBe(1);
    expect(duckGainAt(spans, 0, 3)).toBe(1);
    expect(duckGainAt([], -12, 3)).toBe(1);
  });

  it("builds the same shape as an ffmpeg expression, only from voice clips near the music", () => {
    expect(duckExpression(spans, -12, 0, 20)).toBe(
      "pow(10,-12*max(clip((t-0.75)/0.25,0,1)*clip((6.25-t)/0.25,0,1),clip((t-7.75)/0.25,0,1)*clip((12.25-t)/0.25,0,1))/20)",
    );
    // Times count from the music clip's own start; a clip starting at 10 only meets v2.
    expect(duckExpression(spans, -6, 10, 20)).toBe("pow(10,-6*clip((t+2.25)/0.25,0,1)*clip((2.25-t)/0.25,0,1)/20)");
    expect(duckExpression(spans, -12, 13, 20)).toBeNull();
    expect(duckExpression(spans, 0, 0, 20)).toBeNull();
  });
});

describe("export and hand-off", () => {
  it("mixes voice like music, and ducks only the music", () => {
    const { args, graph } = buildExport(tl, "final", "o.mp4", "g.txt");
    expect(args.join(" ")).toContain("-ss 0 -t 5 -i media/voiceover.wav -ss 10 -t 4 -i media/voiceover.wav -ss 0 -t 20 -i media/bed.mp3");
    const lines = graph.trim().split(";\n");
    expect(lines.slice(-4)).toMatchSnapshot();
    expect(lines.filter((l) => l.includes("volume=volume="))).toHaveLength(1);
  });

  it("puts the voiceover on its own track above the music in the .otio", () => {
    const otio = buildOtio(tl, path.resolve("/studio/projects/demo")) as { tracks: { children: { name: string; kind: string; children: { OTIO_SCHEMA: string; name: string }[] }[] } };
    expect(otio.tracks.children.map((t) => `${t.kind} ${t.name}`)).toEqual(["Video Video 1", "Audio Audio 1", "Audio Voiceover", "Audio Music"]);
    const voice = otio.tracks.children[2].children;
    expect(voice.map((c) => `${c.OTIO_SCHEMA} ${c.name}`)).toEqual(["Gap.1 ", "Clip.2 Intro", "Gap.1 ", "Clip.2 v2"]);
  });
});

describe("voice edit operations", () => {
  it("moves and trims voice clips, refusing overlaps", () => {
    expect(voiceOf(moveAudio(tl, "voice", "v2", 6.5))[1]).toMatchObject({ start: 6.5 });
    expect(moveAudio(tl, "voice", "v2", 5.9)).toBeNull();
    expect(voiceOverlap(tl, { ...voiceOf(tl)[1], start: 5.9 })?.id).toBe("v1");
    expect(moveAudio(tl, "voice", "v2", 6)).not.toBeNull(); // touching is fine
    expect(trimAudio(tl, "voice", "v1", "out", 7.5)).toBeNull(); // would end at 8.5
    expect(voiceOf(trimAudio(tl, "voice", "v1", "out", 7))[0]).toMatchObject({ out: 7 });
    expect(voiceOf(updateAudio(tl, "voice", "v1", { volume: 1.5, fadeIn: 0.3 }))[0]).toMatchObject({ volume: 1.5, fadeIn: 0.3 });
    expect(voiceOf(removeAudio(tl, "voice", "v1"))).toEqual([voiceOf(tl)[1]]);
  });

  it("cuts words out of a voice clip, closing up the gap within that clip only", () => {
    // Remove source 2–3 s from v1 (which plays source 0–5 from timeline 1 s).
    const cut = voiceOf(cutVoiceSourceRange(tl, "vo", 2, 3));
    expect(cut).toEqual<VoiceClip[]>([
      { id: "v1", sourceId: "vo", start: 1, in: 0, out: 2, label: "Intro" },
      { id: "v3", sourceId: "vo", start: 3, in: 3, out: 5 },
      voiceOf(tl)[1],
    ]);
    // Cutting the start keeps the clip's place; cutting a whole clip removes it.
    expect(voiceOf(cutVoiceSourceRange(tl, "vo", 0, 1))[0]).toMatchObject({ id: "v1", start: 1, in: 1, out: 5 });
    expect(voiceOf(cutVoiceSourceRange(tl, "vo", 9, 15)).map((v) => v.id)).toEqual(["v1"]);
    expect(cutVoiceSourceRange(tl, "src1", 0, 1)).toBeNull();
  });

  it("turns ducking on, changes it, and turns it off", () => {
    const off = setDucking(tl, 0)!;
    expect(off.tracks.mix).toBeUndefined();
    expect(setDucking(off, -6)!.tracks.mix).toEqual({ duckMusicUnderVoice: -6 });
    expect(setDucking(off, -50)!.tracks.mix).toEqual({ duckMusicUnderVoice: -30 });
    expect(setDucking(tl, -12)).toBeNull();
  });

  it("describes voice and ducking changes for the outside-change message", () => {
    const next = setDucking(moveAudio(tl, "voice", "v2", 9)!, -18)!;
    expect(summarizeChanges(tl, next)).toEqual(["Moved voiceover v2: 00:00:08:00 → 00:00:09:00", "Music under voice lowered by 18 dB (was 12 dB)"]);
    expect(summarizeChanges(tl, removeAudio(tl, "voice", "v1")!)).toEqual(['Removed voiceover v1 "Intro" (was at 00:00:01:00)']);
  });
});

describe("voice words and placement", () => {
  it("places voiceover words on the timeline", () => {
    const placed = layoutVoice(tl);
    const words = [
      { text: "Welcome", start: 0.5, end: 1 },
      { text: "cut", start: 6, end: 6.5 },
      { text: "later", start: 11, end: 11.5 },
    ];
    expect(wordsOnTimeline(placed, { vo: words }).map((w) => [w.text, w.clipId, w.timelineStart])).toEqual([
      ["Welcome", "v1", 1.5],
      ["later", "v2", 9],
    ]);
    expect(locateVoice(placed, 9)).toMatchObject({ placed: { clip: { id: "v2" } }, sourceTime: 11 });
    expect(locateVoice(placed, 7)).toBeNull();
  });

  it("imports a voiceover after the last one, and refuses one that would overlap", () => {
    const info = { duration: 3.25, hasVideo: false, audioChannels: 1 };
    const added = addImportedSource(tl, "media/vo2.wav", info, { to: "voice" });
    expect(added.clip).toEqual({ id: "v3", track: "voice" });
    expect(voiceOf(added.timeline)[2]).toEqual({ id: "v3", sourceId: "src2", start: 12, in: 0, out: 3.25, volume: 1 });
    expect(added.timeline.tracks.mix).toEqual(tl.tracks.mix);
    expect(Object.keys(added.timeline.tracks)).toEqual(["main", "voice", "music", "mix"]);
    expect(voiceOf(addImportedSource(tl, "media/vo2.wav", { ...info, duration: 2 }, { to: "voice", at: 6 }).timeline)[2].start).toBe(6); // fits the gap
    expect(() => addImportedSource(tl, "media/vo2.wav", info, { to: "voice", at: 5 })).toThrow(/would overlap voiceover clip v1.*choose a start of 12 s or later/);
    expect(() => addImportedSource(tl, "media/silent.mp4", { ...info, hasVideo: true, audioChannels: 0 }, { to: "voice" })).toThrow(
      /has no sound, so it can't go on the voiceover track/,
    );
  });
});

const otioPython = process.env.OTIO_PYTHON;
const hasOtio = !!otioPython && spawnSync(otioPython, ["-c", "import opentimelineio"]).status === 0;

describe.skipIf(!hasOtio)("voiceover in the .otio, read by OpenTimelineIO itself", () => {
  it("has a Voiceover track with each clip where the voice track puts it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tve-otio-voice-"));
    const file = path.join(dir, "exports", await writeOtio(dir, tl));
    const script = [
      "import json, sys, opentimelineio as otio",
      "t = otio.adapters.read_from_file(sys.argv[1])",
      "track = [k for k in t.tracks if k.name == 'Voiceover'][0]",
      "print(json.dumps([[c.name, round(c.range_in_parent().start_time.to_seconds(), 3), round(c.duration().to_seconds(), 3)] for c in track if isinstance(c, otio.schema.Clip)]))",
    ].join("\n");
    const run = spawnSync(otioPython!, ["-c", script, file], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([
      ["Intro", 1, 5],
      ["v2", 8, 4],
    ]);
  });
});
