// HTTP routes for exports: start one, list them with progress, and serve the files.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ExportInfo } from "./api-types.ts";
import { PRESETS, newExportName, runExport, type Preset } from "./export.ts";
import { probe, type ToolStatus } from "./ffmpeg.ts";
import { writeOtio } from "./handoff.ts";
import { enqueue, jobState } from "./jobs.ts";
import { openProject, readTimeline, UserError, withLock } from "./projects.ts";
import { sendFile } from "./serve-file.ts";

const EXPORT_FILE = /^[A-Za-z0-9._-]+\.(mp4|txt|otio)$/;

type Started = { preset: Preset; key: string; createdAt: number };

export function registerExportRoutes(app: FastifyInstance, projectsDir: string, tools: ToolStatus): void {
  // Exports started by this server, per project folder, by name.
  const started = new Map<string, Map<string, Started>>();
  // Durations of finished files, so listing doesn't run ffprobe every time.
  const durations = new Map<string, number>();

  app.post<{ Params: { name: string }; Body: { preset?: unknown } }>("/api/projects/:name/exports", async (req) => {
    if (!tools.ok) throw new UserError(tools.message, 503);
    const preset = req.body?.preset;
    if (!PRESETS.includes(preset as Preset)) throw new UserError(`Choose a preset: ${PRESETS.join(" or ")}.`);
    const dir = await openProject(projectsDir, req.params.name);
    // Export what's in the file right now; the editor saves before asking.
    const current = await readTimeline(dir);
    if (!current.ok) {
      throw new UserError(
        `Nothing was exported because timeline.json has errors. Fix them first:\n- ${current.errors.join("\n- ")}`,
        409,
        "invalid-file",
      );
    }
    const timeline = current.timeline;
    if (timeline.tracks.main.length === 0) throw new UserError("There is nothing to export yet: the timeline has no clips.");

    const mine = started.get(dir) ?? new Map<string, Started>();
    started.set(dir, mine);
    // Pick and reserve the name in one step, so two quick clicks get different names.
    const name = await withLock(`exports:${dir}`, async () => {
      const picked = await newExportName(dir, timeline, preset as Preset, new Set(mine.keys()));
      mine.set(picked, { preset: preset as Preset, key: `export:${dir}:${picked}`, createdAt: Date.now() });
      return picked;
    });
    const key = mine.get(name)!.key;
    enqueue(key, async (onProgress) => {
      const result = await runExport(dir, timeline, preset as Preset, name, onProgress);
      durations.set(path.join(dir, "exports", result.file), result.duration);
    });
    return { name };
  });

  // Hand-off for DaVinci Resolve: an OpenTimelineIO file of the edit, made instantly.
  app.post<{ Params: { name: string } }>("/api/projects/:name/handoff", async (req) => {
    const dir = await openProject(projectsDir, req.params.name);
    const current = await readTimeline(dir);
    if (!current.ok) {
      throw new UserError(`Nothing was exported because timeline.json has errors. Fix them first:\n- ${current.errors.join("\n- ")}`, 409, "invalid-file");
    }
    try {
      return { file: await writeOtio(dir, current.timeline) };
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  });

  app.get<{ Params: { name: string } }>("/api/projects/:name/exports", async (req): Promise<{ exports: ExportInfo[] }> => {
    const dir = await openProject(projectsDir, req.params.name);
    const base = `/api/projects/${encodeURIComponent(req.params.name)}/exports`;
    const mine = started.get(dir) ?? new Map<string, Started>();
    const list = new Map<string, ExportInfo>();

    // Finished files on disk, including ones from earlier sessions.
    const files = await readdir(path.join(dir, "exports")).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".mp4") && EXPORT_FILE.test(f))) {
      const name = file.slice(0, -4);
      const info = await stat(path.join(dir, "exports", file)).catch(() => null);
      if (!info) continue;
      list.set(name, {
        name,
        preset: /_final_/.test(name) ? "final" : /_preview_/.test(name) ? "preview" : null,
        status: "ready",
        progress: 1,
        url: `${base}/${file}?v=${Math.round(info.mtimeMs)}`,
        commandUrl: files.includes(`${name}.ffmpeg.txt`) ? `${base}/${name}.ffmpeg.txt` : undefined,
        size: info.size,
        // When it was started: ffmpeg creates the file as it begins.
        createdAt: mine.get(name)?.createdAt ?? (info.birthtimeMs || info.mtimeMs),
      });
    }

    // Exports this server started: their job state wins over a half-written file.
    for (const [name, s] of mine) {
      const job = jobState(s.key);
      if (!job || job.status === "done") continue;
      list.set(name, {
        name,
        preset: s.preset,
        status: job.status,
        progress: job.progress,
        error: job.error,
        commandUrl: job.status === "failed" ? `${base}/${name}.ffmpeg.txt` : undefined,
        createdAt: s.createdAt,
      });
    }

    // Hand-off files for DaVinci Resolve.
    for (const file of files.filter((f) => f.endsWith(".otio") && EXPORT_FILE.test(f))) {
      const info = await stat(path.join(dir, "exports", file)).catch(() => null);
      if (!info) continue;
      const name = file.slice(0, -5);
      list.set(name, {
        name,
        preset: "resolve",
        status: "ready",
        progress: 1,
        url: `${base}/${file}`,
        size: info.size,
        createdAt: info.birthtimeMs || info.mtimeMs,
      });
    }

    for (const e of list.values()) {
      if (e.status !== "ready" || e.preset === "resolve") continue;
      const file = path.join(dir, "exports", `${e.name}.mp4`);
      if (!durations.has(file)) durations.set(file, await probe(file).then((i) => i.duration, () => NaN));
      const d = durations.get(file)!;
      if (Number.isFinite(d)) e.duration = d;
    }
    return { exports: [...list.values()].sort((a, b) => b.createdAt - a.createdAt) };
  });

  app.get<{ Params: { name: string; file: string } }>("/api/projects/:name/exports/:file", async (req, reply) => {
    const dir = await openProject(projectsDir, req.params.name);
    const file = req.params.file;
    if (!EXPORT_FILE.test(file)) throw new UserError("That isn't an export file name.", 404);
    const full = path.join(dir, "exports", file);
    if (!(await stat(full).catch(() => null))) throw new UserError(`exports/${file} doesn't exist (it may have been deleted).`, 404);
    if (file.endsWith(".otio")) reply.header("Content-Disposition", `attachment; filename="${file}"`);
    const type = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".otio") ? "application/json" : "text/plain; charset=utf-8";
    return sendFile(req, reply, full, type);
  });
}
