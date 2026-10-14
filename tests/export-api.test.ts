import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExportInfo } from "../server/api-types.ts";
import { buildServer } from "../server/app.ts";
import { idle } from "../server/jobs.ts";
import { hasFfmpeg, makeTestVideo } from "./helpers/test-media.ts";

type App = Awaited<ReturnType<typeof buildServer>>;

describe.skipIf(!hasFfmpeg)("exports API", () => {
  let app: App;
  let dir: string;
  const timelineFile = () => path.join(dir, "timeline.json");
  const timeline = {
    version: 1,
    project: "demo",
    fps: 25,
    sources: [{ id: "src1", path: "media/clip.mp4", duration: 3, fps: 25, width: 320, height: 240, audioChannels: 1 }],
    tracks: { main: [{ id: "c1", sourceId: "src1", in: 0, out: 1 }, { id: "c2", sourceId: "src1", in: 2, out: 3, speed: 2 }] },
  };
  const list = async () => (await app.inject({ method: "GET", url: "/api/projects/demo/exports" })).json().exports as ExportInfo[];
  const start = (preset: unknown) => app.inject({ method: "POST", url: "/api/projects/demo/exports", payload: { preset } });

  beforeAll(async () => {
    const projectsDir = await mkdtemp(path.join(tmpdir(), "tve-exports-"));
    app = await buildServer({ projectsDir, tools: { ok: true }, watch: false });
    await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo" } });
    dir = path.join(projectsDir, "demo");
    await mkdir(path.join(dir, "media"), { recursive: true });
    makeTestVideo(path.join(dir, "media", "clip.mp4"), { seconds: 3, width: 320, height: 240 });
    await writeFile(timelineFile(), JSON.stringify(timeline, null, 2));
  });
  afterAll(() => app.close());

  it("renders an export in the background and lists it with its files", async () => {
    const res = await start("preview");
    expect(res.statusCode).toBe(200);
    const { name } = res.json() as { name: string };
    expect(name).toMatch(/^demo_preview_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
    expect(["queued", "running"]).toContain((await list())[0].status);

    await idle();
    const [done] = await list();
    expect(done).toMatchObject({ name, preset: "preview", status: "ready", progress: 1 });
    expect(done.duration).toBeGreaterThan(1.4);
    expect(done.duration).toBeLessThan(1.6);

    const video = await app.inject({ method: "GET", url: done.url!, headers: { range: "bytes=0-9" } });
    expect(video.statusCode).toBe(206);
    const command = await app.inject({ method: "GET", url: done.commandUrl! });
    expect(command.body).toContain(`exports/${name}.mp4`);
    expect(command.body).toContain(`-/filter_complex exports/${name}.filtergraph.txt`);
    expect(await readFile(path.join(dir, "exports", `${name}.filtergraph.txt`), "utf8")).toContain("concat=n=2:v=1:a=1");
  });

  it("gives two exports started in the same second different names", async () => {
    const [a, b] = await Promise.all([start("final"), start("final")]);
    expect(a.json().name).not.toBe(b.json().name);
    await idle();
    expect((await list()).filter((e) => e.preset === "final" && e.status === "ready")).toHaveLength(2);
  });

  it("explains what's wrong instead of exporting", async () => {
    expect((await start("4k")).json().error).toMatch(/Choose a preset: final or preview/);

    await writeFile(timelineFile(), "{ broken");
    const broken = await start("preview");
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toMatch(/Nothing was exported because timeline.json has errors/);

    await writeFile(timelineFile(), JSON.stringify({ ...timeline, tracks: { main: [] } }));
    expect((await start("preview")).json().error).toMatch(/nothing to export yet/);
  });

  it("reports a failed export with the reason", async () => {
    await writeFile(timelineFile(), JSON.stringify({ ...timeline, sources: [{ ...timeline.sources[0], path: "media/missing.mp4" }] }));
    await start("preview");
    await idle();
    const [failed] = await list();
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/media\/missing\.mp4 is missing from the project folder/);
    await writeFile(timelineFile(), JSON.stringify(timeline));
  });

  it("makes a DaVinci Resolve hand-off file and lists it for download", async () => {
    await writeFile(timelineFile(), JSON.stringify(timeline));
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/handoff" });
    expect(res.statusCode).toBe(200);
    const { file } = res.json() as { file: string };
    expect(file).toMatch(/^demo_resolve_[\d_-]+\.otio$/);
    const entry = (await list()).find((e) => e.name === file.slice(0, -5))!;
    expect(entry).toMatchObject({ preset: "resolve", status: "ready" });
    const download = await app.inject({ method: "GET", url: entry.url! });
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="${file}"`);
    expect(download.json().OTIO_SCHEMA).toBe("Timeline.1");
  });

  it("only serves files from exports/", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/demo/exports/..%2Ftimeline.json" });
    expect(res.statusCode).toBe(404);
  });
});
