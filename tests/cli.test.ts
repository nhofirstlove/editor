// The `tl` helpers, run as a real process the way Claude and the validation hook run them.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../schema/timeline.ts";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";

const cli = fileURLToPath(new URL("../cli/tl.ts", import.meta.url));

describe("tl command-line helpers", () => {
  let projectsDir: string;

  function tl(args: string[], cwd = projectsDir) {
    const run = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, PROJECTS_DIR: projectsDir, INIT_CWD: cwd },
    });
    return { code: run.status, out: run.stdout, err: run.stderr };
  }

  async function makeProject(name: string, timeline: Timeline) {
    await mkdir(path.join(projectsDir, name, "media"), { recursive: true });
    await writeFile(path.join(projectsDir, name, "timeline.json"), JSON.stringify(timeline, null, 2));
  }

  const demo: Timeline = {
    version: 1,
    project: "demo",
    fps: 25,
    sources: [{ id: "src1", path: "media/talk.mp4", duration: 4, fps: 25, audioChannels: 1 }],
    tracks: {
      main: [
        { id: "c1", sourceId: "src1", in: 0, out: 1.5, label: "Hello" },
        { id: "c2", sourceId: "src1", in: 2.5, out: 4, speed: 1.5, muted: true, note: "Keep this answer" },
      ],
    },
  };

  beforeAll(async () => {
    projectsDir = await mkdtemp(path.join(tmpdir(), "tve-cli-"));
    await makeProject("demo", demo);
  });

  it("validates a file by path and reports problems with exit code 1", async () => {
    const ok = tl(["validate", path.join(projectsDir, "demo", "timeline.json")]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^OK: .*timeline\.json is valid \(2\.500 s \(00:00:02:12\), 2 clips\)\./);

    const bad = path.join(projectsDir, "bad.json");
    await writeFile(bad, JSON.stringify({ ...demo, tracks: { main: [{ ...demo.tracks.main[0], speed: 9 }] } }));
    const res = tl(["validate", bad]);
    expect(res.code).toBe(1);
    expect(res.err).toContain('tracks.main[0] (clip "c1"): "speed" must be between 0.25 and 4.0 (found 9)');
  });

  it("validates the project's timeline when there is only one project", () => {
    expect(tl(["validate"]).code).toBe(0);
  });

  it("prints a summary with source and timeline times", () => {
    const { code, out } = tl(["summary"]);
    expect(code).toBe(0);
    expect(out).toContain("Project demo | 2 clips | 25 fps | total 2.500 s (00:00:02:12)");
    expect(out).toMatch(/1\s+c1\s+Hello\s+src1\s+0\.000\s+1\.500\s+0\.000\s+1\.500\s+00:00:00:00\s+1x\s+100%/);
    expect(out).toMatch(/2\s+c2\s+src1\s+2\.500\s+4\.000\s+1\.500\s+2\.500\s+00:00:01:12\s+1\.5x\s+100%\s+muted; note: "Keep this answer"/);
    expect(out).toContain("src1  media/talk.mp4  (4.000 s, 25 fps)");
  });

  it("prints the total duration", () => {
    expect(tl(["duration"]).out.trim()).toBe("2.500 s (00:00:02:12), 2 clips");
  });

  it("saves a snapshot to history/", async () => {
    const res = tl(["snapshot"]);
    expect(res.code).toBe(0);
    const files = await readdir(path.join(projectsDir, "demo", "history"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_manual\.json$/);
    expect(await readFile(path.join(projectsDir, "demo", "history", files[0]), "utf8")).toBe(
      await readFile(path.join(projectsDir, "demo", "timeline.json"), "utf8"),
    );
  });

  describe("words", () => {
    // c1 plays source 0–1.5; "um" (1.6–2.0) is cut; c2 plays 2.5–4 at 1.5x from timeline 1.5 s.
    const words = [
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: "there", start: 0.6, end: 1.0 },
      { text: "um", start: 1.6, end: 2.0 },
      { text: "welcome", start: 2.6, end: 3.2 },
      { text: "back.", start: 3.3, end: 3.9 },
    ];
    const run = (args: string[]) => {
      const res = tl(["words", "-p", "demo", ...args]);
      return { ...res, json: res.code === 0 ? JSON.parse(res.out) : null };
    };

    it("explains when there's no transcript yet", () => {
      expect(run([]).err).toMatch(/None of the files in the edit has a transcript yet/);
    });

    it("lists the words that play in the edit, in timeline time", async () => {
      await writeFile(
        path.join(projectsDir, "demo", "transcript.json"),
        JSON.stringify({ version: 1, sources: { src1: { path: "media/talk.mp4", model: "base", createdAt: "2026-10-14T00:00:00Z", words } } }),
      );
      const res = run([]);
      expect(res.json.map((w: { text: string }) => w.text)).toEqual(["Hello", "there", "welcome", "back."]);
      expect(res.json[2]).toEqual({ text: "welcome", start: 1.567, end: 1.967, track: "main", clipId: "c2", sourceId: "src1", sourceStart: 2.6, sourceEnd: 3.2 });
      expect(res.err).toContain("Text: Hello there welcome back.");
    });

    it("filters by a timeline range", () => {
      expect(run(["--from", "1.9", "--to", "2.1"]).json.map((w: { text: string }) => w.text)).toEqual(["welcome", "back."]);
    });

    it("lists a source's words in source time, marking words cut from the edit", () => {
      const res = run(["--source", "src1", "--from", "0.9", "--to", "3"]);
      expect(res.json).toEqual([
        { text: "there", start: 0.6, end: 1.0, inEdit: true, track: "main", timelineStart: 0.6 },
        { text: "um", start: 1.6, end: 2.0, inEdit: false, track: null, timelineStart: null },
        { text: "welcome", start: 2.6, end: 3.2, inEdit: true, track: "main", timelineStart: 1.567 },
      ]);
      expect(res.err).toContain("Text: there [um] welcome");
    });

    it("rejects a backwards range", () => {
      expect(run(["--from", "5", "--to", "2"]).err).toMatch(/--to must be later than --from/);
    });
  });

  it("explains how to pick a project when there are several", async () => {
    await makeProject("other", { ...demo, project: "other" });
    const res = tl(["summary"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("There are several projects (demo, other). Say which one with --project");
    expect(tl(["duration", "--project", "other"]).code).toBe(0);
    expect(tl(["duration", "-p", "other"]).code).toBe(0);
    // Run from inside a project folder, it uses that project.
    expect(tl(["duration"], path.join(projectsDir, "other", "media")).code).toBe(0);
  });

  it("gives clear errors for unknown commands, options and projects", () => {
    expect(tl(["frobnicate"]).err).toMatch(/^Unknown command "frobnicate"/);
    expect(tl(["summary", "-p", "demo", "--fast", "1"]).err).toMatch(/Unknown option --fast/);
    expect(tl(["summary", "-p", "nope"]).err).toMatch(/There is no project called "nope"/);
    expect(tl(["preview", "-p", "demo", "--preset", "final"]).err).toMatch(/Unknown option --preset/);
  });

  it.skipIf(!hasFfmpeg)("finds the silent gap in the source audio, in source time", async () => {
    // A 4 s tone with silence from 1.5 s to 2.5 s.
    makeTestVideo(path.join(projectsDir, "demo", "media", "talk.mp4"), { seconds: 4, width: 320, height: 240, silence: [1.5, 2.5] });
    const res = tl(["silences", "-p", "demo", "--min", "0.6", "--db", "-35"]);
    expect(res.code).toBe(0);
    const found = JSON.parse(res.out) as Array<{ sourceId: string; start: number; end: number; duration: number }>;
    expect(found).toHaveLength(1);
    expect(found[0].sourceId).toBe("src1");
    expect(found[0].start).toBeCloseTo(1.5, 1);
    expect(found[0].end).toBeCloseTo(2.5, 1);
    expect(res.err).toContain("src1: 1 pause(s) of 0.6 s or longer");

    // A minimum longer than the gap finds nothing.
    expect(JSON.parse(tl(["silences", "-p", "demo", "--min", "2"]).out)).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)("renders a quick preview to exports/ and checks its length", async () => {
    // Uses the clip made by the previous test.
    const res = tl(["preview", "-p", "demo"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^Saved .*exports[\\/]demo_preview_[\d_-]+\.mp4\r?$/m);
    expect(res.out).toMatch(/^Length [\d.]+ s; timeline 2\.500 s \(difference 0\.0\d\d s\)\.$/m);
    expect(res.out).not.toContain("Warning");
    expect(res.err).toMatch(/Rendering… \d+%/);
    const files = await readdir(path.join(projectsDir, "demo", "exports"));
    expect(files.filter((f) => f.endsWith(".mp4"))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith(".ffmpeg.txt"))).toHaveLength(1);
  });
});
