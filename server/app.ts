// HTTP API for the browser editor.

import { createWriteStream } from "node:fs";
import type { ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify from "fastify";
import { hasAudio, isImage, validateTimeline, type Source, type Timeline } from "../schema/timeline.ts";
import { wordsFor } from "../schema/transcript.ts";
import type { FileStatus, MediaStatus, ProjectResponse } from "./api-types.ts";
import { registerExportRoutes } from "./export-routes.ts";
import { checkTools, type ToolStatus } from "./ffmpeg.ts";
import { importMedia, timelineBroken } from "./importer.ts";
import { AUTO_SNAPSHOT_INTERVAL_MS, saveSnapshot } from "./history.ts";
import { clearFailed, enqueue, jobState } from "./jobs.ts";
import { makePeaks, makeProxy, peaksFile, proxyFile } from "./media.ts";
import {
  createProject,
  exists,
  formatTimeline,
  listProjects,
  openProject,
  readTimeline,
  revisionOf,
  UserError,
  withLock,
  writeTimeline,
} from "./projects.ts";
import { sendFile } from "./serve-file.ts";
import { checkTranscriber, readTranscript, transcribeSource } from "./transcribe.ts";
import { watchTimelines } from "./watch.ts";

type Options = {
  projectsDir: string;
  tools?: ToolStatus;
  /** Watch timeline files for outside changes (on by default). */
  watch?: boolean;
};

export async function buildServer({ projectsDir, tools = checkTools(), watch = true }: Options) {
  const app = Fastify({ logger: false });
  // Last valid timeline per project folder, so a bad external edit never blanks the editor.
  const lastValid = new Map<string, Timeline>();
  // The timeline.json text this server last read or wrote, per project folder. A file
  // event whose content matches is our own write (or no change) and is ignored.
  const known = new Map<string, { text: string; revision: string }>();
  const lastAutoSnapshot = new Map<string, number>();
  // Browsers listening for changes, per project name.
  const listeners = new Map<string, Set<ServerResponse>>();

  async function saveTimeline(dir: string, timeline: Timeline): Promise<string> {
    const text = formatTimeline(timeline);
    const revision = revisionOf(text);
    known.set(dir, { text, revision }); // before writing, so the watcher knows it's ours
    await writeTimeline(dir, timeline);
    lastValid.set(dir, timeline);
    return revision;
  }

  /** Handles a timeline.json event from the watcher. */
  async function onTimelineFile(dir: string): Promise<void> {
    await withLock(dir, async () => {
      const current = await readTimeline(dir);
      if (current.text === null || current.revision === null) return;
      const before = known.get(dir);
      if (before?.revision === current.revision) return;
      known.set(dir, { text: current.text, revision: current.revision });
      if (!before) return; // first time this server sees the file
      // Changed outside the editor: keep the old version, then tell the browser.
      await saveSnapshot(dir, before.text, "external");
      if (current.ok) lastValid.set(dir, current.timeline);
      notify(path.basename(dir), { type: "timeline", revision: current.revision });
    });
  }

  function notify(name: string, event: object): void {
    for (const res of listeners.get(name) ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (watch) {
    const watcher = watchTimelines(projectsDir, (dir) => void onTimelineFile(dir).catch((err) => console.error(err)));
    await watcher.ready;
    app.addHook("onClose", async () => {
      await watcher.close();
    });
  }
  app.addHook("onClose", async () => {
    for (const set of listeners.values()) for (const res of set) res.end();
  });

  // Uploads arrive as a raw stream; the import route writes it straight to disk.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.code(500).send({
      error: `Something went wrong on the server: ${err.message}. Try again. If it keeps happening, restart the editor (npm run dev).`,
    });
  });

  app.get("/api/health", async () => ({ tools, transcriber: await checkTranscriber() }));

  registerExportRoutes(app, projectsDir, tools);

  app.get("/api/projects", async () => ({ projects: await listProjects(projectsDir) }));

  app.post<{ Body: { name?: unknown } }>("/api/projects", async (req, reply) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    await createProject(projectsDir, name);
    return reply.code(201).send({ name });
  });

  app.get<{ Params: { name: string } }>("/api/projects/:name", async (req): Promise<ProjectResponse> => {
    const dir = await openProject(projectsDir, req.params.name);
    const result = await readTimeline(dir);
    if (result.ok) lastValid.set(dir, result.timeline);
    const timeline = lastValid.get(dir) ?? null;
    const media: ProjectResponse["media"] = {};
    for (const source of timeline?.sources ?? []) media[source.id] = await mediaStatus(dir, req.params.name, source);
    return { name: req.params.name, timeline, revision: result.revision, errors: result.ok ? [] : result.errors, media };
  });

  // Server-sent events: tells the browser as soon as timeline.json changes outside the editor.
  app.get<{ Params: { name: string } }>("/api/projects/:name/events", async (req, reply) => {
    await openProject(projectsDir, req.params.name);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    const set = listeners.get(req.params.name) ?? new Set();
    listeners.set(req.params.name, set);
    set.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      set.delete(res);
    });
  });

  // Saves the editor's timeline. `baseRevision` is the version of the file the editor's
  // change was based on; if the file has changed since (for example Claude edited it),
  // nothing is written, so an outside change is never silently overwritten.
  app.put<{ Params: { name: string }; Body: { timeline?: unknown; baseRevision?: unknown } }>(
    "/api/projects/:name/timeline",
    async (req) => {
      const dir = await openProject(projectsDir, req.params.name);
      return withLock(dir, async () => {
        const current = await readTimeline(dir);
        if (current.revision !== req.body?.baseRevision) {
          throw new UserError(
            "timeline.json was changed outside the editor before this change could be saved, so it wasn't saved. " +
              "The editor now shows the file's version; use Undo to bring your change back.",
            409,
            "conflict",
          );
        }
        if (!current.ok) throw timelineBroken(current.errors, "Nothing was saved");
        const result = validateTimeline(req.body?.timeline);
        if (!result.ok) {
          throw new UserError(`The editor tried to save an invalid timeline, so nothing was written:\n- ${result.errors.join("\n- ")}`);
        }
        // While someone is editing, keep a snapshot at most every 5 minutes.
        const now = Date.now();
        if (current.text !== null && now - (lastAutoSnapshot.get(dir) ?? 0) >= AUTO_SNAPSHOT_INTERVAL_MS) {
          await saveSnapshot(dir, current.text, "auto");
          lastAutoSnapshot.set(dir, now);
        }
        return { revision: await saveTimeline(dir, result.timeline) };
      });
    },
  );

  app.post<{ Params: { name: string }; Querystring: { filename?: string; to?: string } }>("/api/projects/:name/import", async (req) => {
    if (!tools.ok) throw new UserError(tools.message, 503);
    // Audio files can be sent to the voiceover track; everything else goes where it belongs.
    const to = req.query.to === "voice" || req.query.to === "music" ? req.query.to : undefined;
    const dir = await openProject(projectsDir, req.params.name);
    const { source } = await importMedia(
      dir,
      {
        name: req.query.filename || "video.mp4",
        size: Number(req.headers["content-length"]),
        write: (tmp) => pipeline(req.body as Readable, createWriteStream(tmp)),
      },
      { to },
      saveTimeline,
    );
    await mediaStatus(dir, req.params.name, source); // starts proxy and peaks jobs
    return { source };
  });

  app.get<{ Params: { name: string; sourceId: string } }>("/api/projects/:name/sources/:sourceId/proxy", async (req, reply) => {
    const { dir, source } = await findSource(req.params.name, req.params.sourceId);
    const file = proxyFile(dir, source.path, isImage(source));
    if (!(await exists(file))) throw new UserError("The proxy for this file isn't ready yet. Wait for it to finish preparing.", 404);
    return sendFile(req, reply, file, isImage(source) ? "image/jpeg" : "video/mp4");
  });

  app.get<{ Params: { name: string; sourceId: string } }>("/api/projects/:name/sources/:sourceId/peaks", async (req, reply) => {
    const { dir, source } = await findSource(req.params.name, req.params.sourceId);
    const file = peaksFile(dir, source.path);
    if (!(await exists(file))) throw new UserError("The waveform for this video isn't ready yet.", 404);
    return sendFile(req, reply, file, "application/json");
  });

  app.post<{ Params: { name: string; sourceId: string } }>("/api/projects/:name/sources/:sourceId/retry", async (req) => {
    const { dir, source } = await findSource(req.params.name, req.params.sourceId);
    clearFailed(`proxy:${proxyFile(dir, source.path, isImage(source))}`);
    clearFailed(`peaks:${peaksFile(dir, source.path)}`);
    return mediaStatus(dir, req.params.name, source);
  });

  // Transcribes a source with faster-whisper in the background (replacing any earlier transcript).
  app.post<{ Params: { name: string; sourceId: string } }>("/api/projects/:name/sources/:sourceId/transcribe", async (req) => {
    const { dir, source } = await findSource(req.params.name, req.params.sourceId);
    if (!tools.ok) throw new UserError(tools.message, 503);
    const transcriber = await checkTranscriber();
    if (!transcriber.ok) throw new UserError(transcriber.message, 503);
    if (!hasAudio(source)) throw new UserError("This file has no audio track, so there is nothing to transcribe.");
    const key = `transcribe:${dir}:${source.id}`;
    clearFailed(key);
    enqueue(key, (onProgress, onNote) => transcribeSource(dir, source, onProgress, onNote));
    return mediaStatus(dir, req.params.name, source);
  });

  app.get<{ Params: { name: string } }>("/api/projects/:name/transcript", async (req) => {
    const dir = await openProject(projectsDir, req.params.name);
    const { transcript, error } = await readTranscript(dir);
    return { transcript, error };
  });

  async function findSource(name: string, sourceId: string): Promise<{ dir: string; source: Source }> {
    const dir = await openProject(projectsDir, name);
    const result = await readTimeline(dir);
    const timeline = result.ok ? result.timeline : lastValid.get(dir);
    const source = timeline?.sources.find((s) => s.id === sourceId);
    if (!source) throw new UserError(`There is no source "${sourceId}" in this project's timeline.`, 404);
    return { dir, source };
  }

  /** Reports proxy and peaks status for a source, queueing generation for anything missing. */
  async function mediaStatus(dir: string, name: string, source: Source): Promise<MediaStatus> {
    const original = path.join(dir, source.path);
    if (!(await exists(original))) {
      const missing: FileStatus = {
        status: "missing-source",
        progress: 0,
        error: `The original file ${source.path} is missing from the project folder. Put it back with the same name.`,
      };
      return { proxy: missing, peaks: missing, transcript: missing };
    }
    const base = `/api/projects/${encodeURIComponent(name)}/sources/${encodeURIComponent(source.id)}`;
    const duration = source.duration ?? 0;

    let peaks: FileStatus;
    if (!hasAudio(source)) {
      peaks = { status: "no-audio", progress: 0 };
    } else {
      const file = peaksFile(dir, source.path);
      peaks = await fileStatus(`peaks:${file}`, file, `${base}/peaks`, (p) => makePeaks(original, file, duration, p));
    }
    const file = proxyFile(dir, source.path, isImage(source));
    const proxy = await fileStatus(`proxy:${file}`, file, `${base}/proxy`, (p) => makeProxy(original, file, duration, p));
    return { proxy, peaks, transcript: await transcriptStatus(dir, name, source) };
  }

  /** Transcripts are only made when asked for, so this never starts a job. */
  async function transcriptStatus(dir: string, name: string, source: Source): Promise<FileStatus> {
    const job = jobState(`transcribe:${dir}:${source.id}`);
    if (job && job.status !== "done") return { status: job.status, progress: job.progress, error: job.error, note: job.note };
    if (!hasAudio(source)) return { status: "no-audio", progress: 0 };
    const file = await readTranscript(dir);
    if (wordsFor(file.transcript, source.id, source.path)) {
      return { status: "ready", progress: 1, url: `/api/projects/${encodeURIComponent(name)}/transcript?v=${Math.round(file.mtimeMs ?? 0)}` };
    }
    return { status: "not-started", progress: 0, error: file.error ?? undefined };
  }

  async function fileStatus(key: string, file: string, url: string, make: (onProgress: (p: number) => void) => Promise<void>): Promise<FileStatus> {
    const info = await stat(file).catch(() => null);
    // The version query makes the browser fetch a fresh copy if the file is regenerated.
    if (info) return { status: "ready", progress: 1, url: `${url}?v=${Math.round(info.mtimeMs)}` };
    if (!tools.ok) return { status: "failed", progress: 0, error: tools.message };
    enqueue(key, make);
    const state = jobState(key)!;
    return { status: state.status === "done" ? "queued" : state.status, progress: state.progress, error: state.error };
  }

  return app;
}
