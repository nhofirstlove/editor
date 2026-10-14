// The file watcher: outside changes are snapshotted and pushed to the browser; the
// editor's own saves are not reported back as outside changes.

import { mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectResponse } from "../server/api-types.ts";
import { buildServer } from "../server/app.ts";

type App = Awaited<ReturnType<typeof buildServer>>;

describe("watching timeline.json", () => {
  let app: App;
  let projectsDir: string;
  let base: string;
  const events: Array<{ type: string; revision: string }> = [];
  let stream: http.ClientRequest;

  const file = () => path.join(projectsDir, "demo", "timeline.json");
  const history = () => readdir(path.join(projectsDir, "demo", "history"));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await wait(25);
    }
    throw new Error("timed out waiting");
  }
  /** Writes the way editors and Claude do: temp file, then rename. */
  async function writeOutside(content: object) {
    await writeFile(`${file()}.ext`, JSON.stringify(content, null, 2));
    await rename(`${file()}.ext`, file());
  }
  const timeline = (fps: number) => ({ version: 1, project: "demo", fps, sources: [], tracks: { main: [] } });

  beforeAll(async () => {
    projectsDir = await mkdtemp(path.join(tmpdir(), "tve-watch-"));
    app = await buildServer({ projectsDir, tools: { ok: true } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo" } });
    await wait(300); // let the watcher see the new file

    // Listen for pushed events like the browser does.
    await new Promise<void>((resolve) => {
      stream = http.get(`${base}/api/projects/demo/events`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          for (const m of chunk.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
        });
        resolve();
      });
    });
  });
  afterAll(async () => {
    stream?.destroy();
    await app.close();
  });

  it("pushes an outside change and snapshots the version it replaced", async () => {
    const original = await readFile(file(), "utf8");
    await writeOutside(timeline(30));
    await until(() => events.length === 1);
    const { revision } = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(events[0]).toEqual({ type: "timeline", revision });

    const snaps = await history();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_external\.json$/);
    expect(await readFile(path.join(projectsDir, "demo", "history", snaps[0]), "utf8")).toBe(original);
  });

  it("does not report the editor's own saves, and snapshots before the first save", async () => {
    const { revision } = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    const res = await app.inject({ method: "PUT", url: "/api/projects/demo/timeline", payload: { timeline: timeline(25), baseRevision: revision } });
    expect(res.statusCode).toBe(200);
    await wait(500);
    expect(events).toHaveLength(1);
    const snaps = await history();
    expect(snaps.filter((s) => s.includes("_auto"))).toHaveLength(1);

    // A second save within 5 minutes doesn't snapshot again.
    const res2 = await app.inject({
      method: "PUT",
      url: "/api/projects/demo/timeline",
      payload: { timeline: timeline(24), baseRevision: res.json().revision },
    });
    expect(res2.statusCode).toBe(200);
    await wait(300);
    expect((await history()).filter((s) => s.includes("_auto"))).toHaveLength(1);
  });

  it("ignores a write that doesn't change the content", async () => {
    const text = await readFile(file(), "utf8");
    await writeFile(file(), text);
    await wait(500);
    expect(events).toHaveLength(1);
  });

  it("pushes a change that makes the file invalid, and keeps serving the last valid version", async () => {
    await writeFile(file(), "{ broken");
    await until(() => events.length === 2);
    const res = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(res.errors[0]).toMatch(/not valid JSON/);
    expect(res.timeline).toMatchObject({ fps: 24 });
  });
});
