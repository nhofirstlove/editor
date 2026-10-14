// Milestones 7–9: a pipeline builds, delivers and exports a project with only the
// command line (no server, no browser), the way an automated video pipeline would.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";
import { canTranscribe, speechSample } from "./helpers/whisper.ts";

const cli = fileURLToPath(new URL("../cli/tl.ts", import.meta.url));

describe.skipIf(!hasFfmpeg)("headless pipeline (command line only)", () => {
  let root: string;
  let projectsDir: string;
  let assets: string;
  const project = () => path.join(projectsDir, "demo");
  const readTl = async () => JSON.parse(await readFile(path.join(project(), "timeline.json"), "utf8"));

  function tl(...args: string[]) {
    const env = { ...process.env, PROJECTS_DIR: projectsDir, INIT_CWD: assets, WHISPER_MODEL: "base" };
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
    let json: any = null; // loosely typed: tests read into whatever the command printed
    try {
      json = JSON.parse(run.stdout);
    } catch {
      // Not JSON output.
    }
    return { code: run.status, out: run.stdout, err: run.stderr, json };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "tve-headless-"));
    projectsDir = path.join(root, "projects");
    assets = path.join(root, "assets");
    await mkdir(assets, { recursive: true });
    // What a pipeline would have made: two shots and a music bed.
    makeTestVideo(path.join(assets, "shot 1.mp4"), { seconds: 3, width: 640, height: 360 });
    makeTestVideo(path.join(assets, "shot2.mp4"), { seconds: 2, width: 640, height: 360 });
    const music = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", path.join(assets, "bed.wav")]);
    if (music.status !== 0) throw new Error(music.stderr.toString());
    const still = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=800x600", "-frames:v", "1", path.join(assets, "still.png")]);
    if (still.status !== 0) throw new Error(still.stderr.toString());
    await writeFile(path.join(assets, "broken.png"), "not really a png");
  });

  it("creates a project in the version 2 format", async () => {
    const res = tl("new", "demo", "--json");
    expect(res.code).toBe(0);
    expect(res.json).toEqual({ project: "demo", dir: project() });
    expect(await readTl()).toEqual({ version: 2, project: "demo", sources: [], tracks: { main: [] } });
    expect(tl("new", "demo").err).toMatch(/already exists/);
  });

  it("imports shots onto the main track and music onto the music track", async () => {
    const shots = tl("import", "shot 1.mp4", "shot2.mp4", "-p", "demo", "--json");
    expect(shots.code).toBe(0);
    expect(shots.json.map((r: { sourceId: string; path: string; clipId: string; track: string }) => [r.sourceId, r.path, r.clipId, r.track])).toEqual([
      ["src1", "media/shot_1.mp4", "c1", "main"],
      ["src2", "media/shot2.mp4", "c2", "main"],
    ]);
    const music = tl("import", "bed.wav", "-p", "demo", "--at", "1.5", "--json");
    expect(music.json[0]).toMatchObject({ sourceId: "src3", clipId: "m1", track: "music" });
    const timeline = await readTl();
    expect(timeline.tracks.music).toEqual([{ id: "m1", sourceId: "src3", start: 1.5, in: 0, out: timeline.sources[2].duration, volume: 0.3 }]);
    expect((await readdir(path.join(project(), "media"))).sort()).toEqual(["bed.wav", "shot2.mp4", "shot_1.mp4"]);
  });

  it("imports narration onto the voiceover track, one file after another", async () => {
    const first = tl("import", "bed.wav", "-p", "demo", "--to", "voice", "--json");
    expect(first.json[0]).toMatchObject({ clipId: "v1", track: "voice" });
    const second = tl("import", "bed.wav", "-p", "demo", "--to", "voice", "--json");
    expect(second.json[0]).toMatchObject({ clipId: "v2", track: "voice" });
    const { tracks, sources } = await readTl();
    const length = sources.find((s: { id: string }) => s.id === first.json[0].sourceId).duration;
    expect(tracks.voice.map((v: { id: string; start: number; volume: number }) => [v.id, v.start, v.volume])).toEqual([
      ["v1", 0, 1],
      ["v2", length, 1],
    ]);
    expect(tl("import", "bed.wav", "-p", "demo", "--to", "voice", "--at", "2").err).toMatch(/would overlap voiceover clip v1/);
    expect(tl("summary", "-p", "demo").out).toMatch(/Voiceover track[\s\S]*v2/);
  });

  it("can import a file as a source only, for the pipeline to place itself", async () => {
    const res = tl("import", "shot2.mp4", "-p", "demo", "--to", "none", "--json");
    expect(res.json[0]).toMatchObject({ sourceId: "src6", path: "media/shot2-2.mp4", clipId: null, track: null });
    expect((await readTl()).tracks.main).toHaveLength(2);
  });

  it("explains imports it can't do", () => {
    expect(tl("import", "bed.wav", "-p", "demo", "--to", "main").err).toMatch(/has no picture, so it can't go on the main track/);
    expect(tl("import", "missing.mp4", "-p", "demo").err).toMatch(/Can't find the file/);
    expect(tl("import", "broken.png", "-p", "demo").err).toMatch(/"broken.png" can't be imported/);
    expect(tl("import", "still.png", "-p", "demo", "--to", "music").err).toMatch(/is a still image, so it can only go on the main track/);
    expect(tl("import", "bed.wav", "-p", "demo", "--to", "sideways").err).toMatch(/--to must be main, voice, music or none/);
    const failed = tl("import", "missing.mp4", "-p", "demo", "--json");
    expect(failed.code).toBe(1);
    expect(failed.json).toEqual({ ok: false, error: expect.stringMatching(/Can't find the file/) });
  });

  it("imports a still image onto the end of the main track, for 3 seconds", async () => {
    const res = tl("import", "still.png", "-p", "demo", "--json");
    expect(res.json[0]).toMatchObject({ sourceId: "src7", path: "media/still.png", clipId: "c3", track: "main" });
    const timeline = await readTl();
    expect(timeline.sources.at(-1)).toEqual({ id: "src7", kind: "image", path: "media/still.png", width: 800, height: 600 });
    expect(timeline.tracks.main.at(-1)).toEqual({ id: "c3", sourceId: "src7", in: 0, out: 3 });
    expect(timeline.resolution).toEqual({ width: 640, height: 360 }); // still the video's size
  });

  it("delivers an assembled timeline with set, keeping the previous one", async () => {
    // The pipeline writes its own edit (here in the version 1 format, which still works).
    const assembled = {
      version: 1,
      fps: 25,
      sources: (await readTl()).sources,
      tracks: {
        main: [
          { id: "c1", sourceId: "src2", in: 0, out: 2, label: "Hook" },
          { id: "c2", sourceId: "src1", in: 0.5, out: 3, speed: 1.25, note: "Shot regenerated twice; check the hands" },
          { id: "c3", sourceId: "src7", in: 0, out: 1, fit: "cover", zoom: { from: 1, to: 1.2 } },
        ],
        voice: [{ id: "v1", sourceId: "src4", start: 0.5, in: 0, out: 3 }],
        music: [{ id: "m1", sourceId: "src3", start: 0, in: 0, out: 4, volume: 0.25, fadeOut: 1 }],
        mix: { duckMusicUnderVoice: -12 },
      },
    };
    await writeFile(path.join(assets, "assembled.json"), JSON.stringify(assembled));
    const res = tl("set", "--file", "assembled.json", "-p", "demo", "--json");
    expect(res.code).toBe(0);
    expect(res.json).toEqual({ ok: true, project: "demo", clips: 3, duration: 5 });
    const written = await readTl();
    expect(written.version).toBe(2);
    expect(written.project).toBe("demo");
    expect(written.tracks.main[1].note).toBe("Shot regenerated twice; check the hands");
    expect(written.tracks.mix).toEqual({ duckMusicUnderVoice: -12 });
    expect((await readdir(path.join(project(), "history"))).some((f) => f.endsWith("_set.json"))).toBe(true);
  });

  it("refuses a timeline with problems or with media that isn't in the project", async () => {
    await writeFile(path.join(assets, "bad.json"), JSON.stringify({ version: 2, sources: [], tracks: { main: [{ id: "c1", sourceId: "x", in: 2, out: 1 }] } }));
    const bad = tl("set", "--file", "bad.json", "-p", "demo");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/problem\(s\), so nothing was changed[\s\S]*"in" \(2\) must be less than "out" \(1\)/);

    await writeFile(
      path.join(assets, "elsewhere.json"),
      JSON.stringify({ version: 2, sources: [{ id: "s", path: "media/not-imported.mp4", duration: 5 }], tracks: { main: [{ id: "c1", sourceId: "s", in: 0, out: 1 }] } }),
    );
    expect(tl("set", "--file", "elsewhere.json", "-p", "demo").err).toMatch(/aren't in demo's media folder yet[\s\S]*media\/not-imported\.mp4/);
    expect((await readTl()).tracks.main).toHaveLength(3); // unchanged
  });

  it("validates and summarises as JSON", () => {
    expect(tl("validate", "-p", "demo", "--json").json).toMatchObject({ ok: true, duration: 5, clips: 3 });
    const summary = tl("summary", "-p", "demo", "--json").json;
    expect(summary.main.map((c: { id: string; start: number; end: number }) => [c.id, c.start, c.end])).toEqual([
      ["c1", 0, 2],
      ["c2", 2, 4],
      ["c3", 4, 5],
    ]);
    expect(tl("duration", "-p", "demo", "--json").json).toEqual({ seconds: 5, timecode: "00:00:05:00", clips: 3 });
    expect(tl("summary", "-p", "demo").out).toMatch(/c3 .*still image; zoom 1x->1.2x; fit: cover/);
  });

  it("exports the edit to the right length, and copies it where asked", async () => {
    const res = tl("export", "--preview", "-p", "demo", "--out", "delivered.mp4", "--json");
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ preset: "preview", expectedDuration: 5, withinOneFramePerClip: true });
    expect(Math.abs(res.json.duration - 5)).toBeLessThan(0.1);
    expect(res.json.copy).toBe(path.join(assets, "delivered.mp4"));
    expect(await readdir(assets)).toContain("delivered.mp4");
    expect(res.err).toMatch(/Rendering… \d+%/);
    expect(tl("export", "-p", "demo").err).toMatch(/--final \(full quality\) or --preview/);
  });

  it("writes the DaVinci Resolve hand-off", async () => {
    const res = tl("handoff", "-p", "demo", "--json");
    expect(res.code).toBe(0);
    const otio = JSON.parse(await readFile(res.json.file, "utf8"));
    expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
    expect(otio.tracks.children.map((t: { name: string }) => t.name)).toEqual(["Video 1", "Audio 1", "Voiceover", "Music"]);
  });

  it.skipIf(!canTranscribe)("transcribes from the command line, so words can find what's said", async () => {
    const speech = path.join(assets, "speech.mp4");
    const made = spawnSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x120:r=25:d=13",
      "-i", speechSample, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", speech,
    ]);
    expect(made.status).toBe(0);
    const imported = tl("import", "speech.mp4", "-p", "demo", "--to", "none", "--json").json[0];

    const res = tl("transcribe", "--source", imported.sourceId, "-p", "demo", "--json");
    expect(res.code).toBe(0);
    expect(res.json[0]).toMatchObject({ sourceId: imported.sourceId, language: "en" });
    expect(res.json[0].words).toBeGreaterThan(20);

    const found = tl("words", "--source", imported.sourceId, "-p", "demo");
    // Imported as a source only, so its words aren't in the edit: they're shown [in brackets].
    expect(found.err.replace(/[[\]]/g, "").toLowerCase()).toContain("welcome to the studio");
    expect(tl("transcribe", "--source", "nope", "-p", "demo").err).toMatch(/There is no source "nope"/);

    // Used as the voiceover from 1 s on the timeline, its words are listed in timeline time.
    const current = await readTl();
    current.tracks.voice = [{ id: "v1", sourceId: imported.sourceId, start: 1, in: 0, out: 3 }];
    await writeFile(path.join(assets, "with-voice.json"), JSON.stringify(current));
    expect(tl("set", "--file", "with-voice.json", "-p", "demo").code).toBe(0);
    const words = tl("words", "-p", "demo", "--json").json.filter((w: { track: string }) => w.track === "voice");
    expect(words.length).toBeGreaterThan(2);
    for (const w of words) expect(w.start).toBeCloseTo(w.sourceStart + 1, 3);
    expect(words[0]).toMatchObject({ clipId: "v1", sourceId: imported.sourceId });
  }, 120_000);
});
