import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectResponse } from "../server/api-types.ts";
import { buildServer } from "../server/app.ts";
import { idle } from "../server/jobs.ts";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";

type App = Awaited<ReturnType<typeof buildServer>>;

describe("projects API", () => {
  let app: App;
  let projectsDir: string;

  beforeAll(async () => {
    projectsDir = await mkdtemp(path.join(tmpdir(), "tve-projects-"));
    app = await buildServer({ projectsDir, tools: { ok: true }, watch: false });
  });
  afterAll(() => app.close());

  it("creates a project with the standard folders and an empty timeline", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo" } });
    expect(res.statusCode).toBe(201);
    expect((await readdir(path.join(projectsDir, "demo"))).sort()).toEqual(
      ["exports", "history", "media", "peaks", "proxies", "timeline.json"],
    );
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json()).toEqual({ projects: ["demo"] });
  });

  it("refuses duplicate and unsafe project names with a readable error", async () => {
    const dup = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatch(/already exists/);
    const bad = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "../evil" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/can't be used as a project name/);
  });

  it("says clearly when a project doesn't exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/There is no project called "nope"/);
  });

  it("keeps showing the last valid timeline while the file is invalid, and never rewrites it", async () => {
    const file = path.join(projectsDir, "demo", "timeline.json");
    const first = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(first.errors).toEqual([]);

    const broken = '{ "version": 1, "sources": [], "tracks": { "main": [ { "id": "c1" } ] } }';
    await writeFile(file, broken);
    const res = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(res.timeline).toEqual(first.timeline);
    expect(res.errors).toContain('tracks.main[0] (clip "c1"): "sourceId" is missing');

    const imp = await app.inject({
      method: "POST",
      url: "/api/projects/demo/import?filename=x.mp4",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("not a video"),
    });
    expect(imp.statusCode).toBe(409);
    expect(imp.json().error).toMatch(/Nothing was imported because timeline.json has errors/);
    expect(await readFile(file, "utf8")).toBe(broken);
    expect(await readdir(path.join(projectsDir, "demo", "media"))).toEqual([]);

    await writeFile(file, JSON.stringify(first.timeline));
  });

  describe("saving the timeline", () => {
    const file = () => path.join(projectsDir, "demo", "timeline.json");
    const get = async () => (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    const save = (timeline: unknown, baseRevision: unknown) =>
      app.inject({ method: "PUT", url: "/api/projects/demo/timeline", payload: { timeline, baseRevision } });
    const edited = { version: 1, project: "demo", sources: [], tracks: { main: [] }, fps: 30 };
    // Later tests import into this project; give them back an empty timeline.
    afterAll(() => writeFile(file(), JSON.stringify({ version: 1, project: "demo", sources: [], tracks: { main: [] } })));

    it("writes the editor's change when the file hasn't changed since it was loaded", async () => {
      const { revision } = await get();
      const res = await save(edited, revision);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ ...edited, version: 2 }); // written as format version 2
      // The new revision matches what's on disk, so the next save works too.
      expect(res.json().revision).toBe((await get()).revision);
      expect((await save({ ...edited, fps: 25 }, res.json().revision)).statusCode).toBe(200);
    });

    it("refuses to overwrite a change made outside the editor", async () => {
      const { revision } = await get();
      const outside = JSON.stringify({ ...edited, fps: 24 }, null, 2);
      await writeFile(file(), outside);
      const res = await save(edited, revision);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "conflict", error: expect.stringMatching(/changed outside the editor/) });
      expect(await readFile(file(), "utf8")).toBe(outside);
    });

    it("refuses to save over an invalid file", async () => {
      await writeFile(file(), "{ not json");
      const { revision } = await get();
      const res = await save(edited, revision);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("invalid-file");
      expect(await readFile(file(), "utf8")).toBe("{ not json");
    });

    it("refuses an invalid timeline from the editor and explains why", async () => {
      await writeFile(file(), JSON.stringify(edited));
      const { revision } = await get();
      const res = await save({ ...edited, fps: -1 }, revision);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/invalid timeline, so nothing was written[\s\S]*"fps" must be more than 0/);
      expect(JSON.parse(await readFile(file(), "utf8"))).toEqual(edited); // refused: left exactly as it was
    });
  });

  it("rejects a file that isn't a video without touching media/", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/import?filename=notes.txt",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("hello"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/"notes.txt" can't be imported/);
    expect(await readdir(path.join(projectsDir, "demo", "media"))).toEqual([]);
    expect((await readdir(path.join(projectsDir, "demo"))).filter((f) => f.startsWith(".import"))).toEqual([]);
  });

  it.skipIf(!hasFfmpeg)("imports an audio file onto the music track, with an audio-only proxy", async () => {
    const song = path.join(projectsDir, "song.wav");
    const made = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", song]);
    expect(made.status).toBe(0);
    await app.inject({ method: "POST", url: "/api/projects", payload: { name: "music" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/music/import?filename=song.wav",
      headers: { "content-type": "application/octet-stream" },
      payload: await readFile(song),
    });
    expect(res.statusCode).toBe(200);
    const tl = JSON.parse(await readFile(path.join(projectsDir, "music", "timeline.json"), "utf8"));
    expect(tl.tracks.main).toEqual([]);
    expect(tl.tracks.music).toEqual([{ id: "m1", sourceId: "src1", start: 0, in: 0, out: tl.sources[0].duration, volume: 0.3 }]);
    await idle();
    const media = ((await app.inject({ method: "GET", url: "/api/projects/music" })).json() as ProjectResponse).media.src1;
    expect([media.proxy.status, media.peaks.status]).toEqual(["ready", "ready"]);
  });

  it.skipIf(!hasFfmpeg)("imports a video, probes it, and prepares a proxy and waveform", async () => {
    const clip = path.join(projectsDir, "upload.mp4");
    makeTestVideo(clip, { seconds: 3, width: 1280, height: 720 });
    const bytes = await readFile(clip);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/import?filename=" + encodeURIComponent("Interview take 2.mp4"),
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toMatchObject({ id: "src1", path: "media/Interview_take_2.mp4", fps: 25, width: 1280, height: 720, audioChannels: 1 });

    // The copy in media/ is byte-for-byte the uploaded file.
    expect((await readFile(path.join(projectsDir, "demo", "media", "Interview_take_2.mp4"))).equals(bytes)).toBe(true);

    const tl = JSON.parse(await readFile(path.join(projectsDir, "demo", "timeline.json"), "utf8"));
    expect(tl.fps).toBe(25);
    expect(tl.resolution).toEqual({ width: 1280, height: 720 });
    expect(tl.tracks.main).toEqual([{ id: "c1", sourceId: "src1", in: 0, out: tl.sources[0].duration, speed: 1, volume: 1, muted: false }]);

    await idle();
    const project = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    const media = project.media.src1;
    expect(media.proxy.status).toBe("ready");
    expect(media.peaks.status).toBe("ready");

    // The proxy supports HTTP Range requests, which browsers need for seeking.
    const range = await app.inject({ method: "GET", url: media.proxy.url!, headers: { range: "bytes=0-99" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(range.rawPayload.length).toBe(100);
    const tail = await app.inject({ method: "GET", url: media.proxy.url!, headers: { range: "bytes=-10" } });
    expect(tail.rawPayload.length).toBe(10);
    const outOfRange = await app.inject({ method: "GET", url: media.proxy.url!, headers: { range: "bytes=999999999-" } });
    expect(outOfRange.statusCode).toBe(416);

    const peaks = await app.inject({ method: "GET", url: media.peaks.url! });
    expect(peaks.json().peaks.length).toBeGreaterThan(250);
  });
});
