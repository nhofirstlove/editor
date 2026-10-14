// Calls to the local API server. Every failure becomes an Error with a readable message.

import type { Source, Timeline } from "../../schema/timeline.ts";
import type { Transcript } from "../../schema/transcript.ts";
import type { ExportInfo, HealthResponse, MediaStatus, PeaksFile, ProjectResponse } from "../../server/api-types.ts";

const SERVER_DOWN = "Can't reach the editor's server. Make sure `npm run dev` is still running in the terminal, then reload this page.";

/** An error from the server, with its machine-readable `code` when there is one (e.g. "conflict"). */
export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(SERVER_DOWN, "offline");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error ?? (res.status >= 500 ? SERVER_DOWN : `The server answered with error ${res.status}.`), data?.code);
  }
  return data as T;
}

export const api = {
  health: () => request<HealthResponse>("GET", "/api/health"),
  listProjects: () => request<{ projects: string[] }>("GET", "/api/projects"),
  createProject: (name: string) => request<{ name: string }>("POST", "/api/projects", { name }),
  project: (name: string) => request<ProjectResponse>("GET", `/api/projects/${encodeURIComponent(name)}`),
  retry: (name: string, sourceId: string) =>
    request<MediaStatus>("POST", `/api/projects/${encodeURIComponent(name)}/sources/${encodeURIComponent(sourceId)}/retry`),
  peaks: (url: string) => request<PeaksFile>("GET", url),
  exports: (name: string) => request<{ exports: ExportInfo[] }>("GET", `/api/projects/${encodeURIComponent(name)}/exports`),
  startExport: (name: string, preset: "final" | "preview") =>
    request<{ name: string }>("POST", `/api/projects/${encodeURIComponent(name)}/exports`, { preset }),
  transcript: (url: string) => request<{ transcript: Transcript | null; error: string | null }>("GET", url),
  transcribe: (name: string, sourceId: string) =>
    request<MediaStatus>("POST", `/api/projects/${encodeURIComponent(name)}/sources/${encodeURIComponent(sourceId)}/transcribe`),
  handoff: (name: string) => request<{ file: string }>("POST", `/api/projects/${encodeURIComponent(name)}/handoff`),
  saveTimeline: (name: string, timeline: Timeline, baseRevision: string | null) =>
    request<{ revision: string }>("PUT", `/api/projects/${encodeURIComponent(name)}/timeline`, { timeline, baseRevision }),
};

/** Uploads a file into the project's media/ folder, reporting progress (0..1). */
export function importFile(project: string, file: File, onProgress: (p: number) => void, to?: "voice" | "music"): Promise<{ source: Source }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${encodeURIComponent(project)}/import?filename=${encodeURIComponent(file.name)}${to ? `&to=${to}` : ""}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new Error(SERVER_DOWN));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
      let message = `The import failed (error ${xhr.status}).`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        if (xhr.status >= 500) message = SERVER_DOWN;
      }
      reject(new Error(message));
    };
    xhr.send(file);
  });
}
