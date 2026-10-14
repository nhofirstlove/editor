// The open project's timeline, kept in step with timeline.json on disk.
//
// - Every edit is written to the file about 300 ms later (the server writes atomically).
// - Each save says which version of the file it was based on. If the file changed in
//   the meantime (for example Claude edited it), the server refuses the save and the
//   editor switches to the file's version, so an outside change is never overwritten.
// - Undo/redo covers both editor changes and changes picked up from the file.
// - The server pushes a message as soon as the file changes outside the editor; the
//   editor then reloads it and summarizes what changed.
// - While the file on disk is invalid, editing is paused until it's fixed.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ProjectResponse } from "../../server/api-types.ts";
import { validateTimeline, type Timeline } from "../../schema/timeline.ts";
import { api, ApiError } from "./api.ts";
import { summarizeChanges } from "./changes.ts";

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 2000;
const HISTORY_LIMIT = 200;
/** Edits with the same key this close together (dragging a slider, typing) undo as one step. */
const MERGE_WINDOW_MS = 1500;
/** How often to check for proxy/waveform progress, and as a backup to pushed changes. */
const POLL_BUSY_MS = 1000;
const POLL_IDLE_MS = 10_000;

export type SaveState = "saved" | "pending" | "saving" | "error";

type Doc = {
  server: ProjectResponse | null;
  timeline: Timeline | null;
  /** Version of timeline.json that `timeline` was loaded from or last saved as. */
  revision: string | null;
  dirty: boolean;
  saving: boolean;
  past: Timeline[];
  future: Timeline[];
  lastKey: string | null;
  lastKeyAt: number;
  loadError: string | null;
  saveError: string | null;
  /** A one-off message for the person editing (e.g. why an edit didn't happen). */
  notice: string | null;
  /** What changed in the last outside change, while it can still be undone in one step. */
  external: string[] | null;
};

export function useTimelineDoc(name: string) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const doc = useRef<Doc>({
    server: null,
    timeline: null,
    revision: null,
    dirty: false,
    saving: false,
    past: [],
    future: [],
    lastKey: null,
    lastKeyAt: 0,
    loadError: null,
    saveError: null,
    notice: null,
    external: null,
  }).current;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function remember(tl: Timeline) {
    doc.past.push(tl);
    if (doc.past.length > HISTORY_LIMIT) doc.past.shift();
  }

  /** Reloads from the server. `announce: false` skips the change summary (e.g. after an import). */
  const refresh = useCallback(async ({ announce = true }: { announce?: boolean } = {}) => {
    try {
      const res = await api.project(name);
      doc.server = res;
      doc.loadError = null;
      const fileIsValid = res.timeline !== null && res.errors.length === 0;
      if (!doc.timeline && res.timeline) {
        doc.timeline = res.timeline;
        if (fileIsValid) doc.revision = res.revision;
      } else if (fileIsValid && !doc.dirty && !doc.saving && res.revision !== doc.revision) {
        // The file changed outside the editor. Take its version, keeping ours undoable.
        if (doc.timeline) remember(doc.timeline);
        doc.external = announce && doc.timeline && res.timeline ? summarizeChanges(doc.timeline, res.timeline) : null;
        doc.future = [];
        doc.lastKey = null;
        doc.timeline = res.timeline;
        doc.revision = res.revision;
      }
    } catch (err) {
      doc.loadError = (err as Error).message;
    }
    rerender();
  }, [name, doc]);

  const save = useCallback(async () => {
    if (doc.saving || !doc.dirty || !doc.timeline) return;
    doc.saving = true;
    doc.dirty = false;
    rerender();
    try {
      const { revision } = await api.saveTimeline(name, doc.timeline, doc.revision);
      doc.revision = revision;
      doc.saveError = null;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "conflict" || code === "invalid-file") {
        // The file changed under us: never overwrite it. Show the file's version instead;
        // our version goes into the undo history when refresh() adopts the file.
        doc.notice = (err as Error).message;
        doc.dirty = false;
        doc.revision = null;
      } else {
        doc.dirty = true;
        doc.saveError = `Couldn't save: ${(err as Error).message} Trying again…`;
        saveTimer.current = setTimeout(() => void save(), RETRY_DELAY_MS);
      }
    } finally {
      doc.saving = false;
    }
    if (doc.revision === null) await refresh();
    else if (doc.dirty && !doc.saveError) void save();
    rerender();
  }, [name, doc, refresh]);

  function scheduleSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }

  const canEdit = doc.timeline !== null && doc.server !== null && doc.server.errors.length === 0;

  /** Applies an edit. Edits sharing `mergeKey` in quick succession undo as one step. */
  const applyEdit = useCallback(
    (next: Timeline | null, mergeKey?: string) => {
      if (!next || !doc.timeline || !canEdit) return;
      const check = validateTimeline(next);
      if (!check.ok) {
        doc.notice = `That change wasn't made because it would break the timeline: ${check.errors.join("; ")}`;
        rerender();
        return;
      }
      const now = Date.now();
      const merge = mergeKey !== undefined && mergeKey === doc.lastKey && now - doc.lastKeyAt < MERGE_WINDOW_MS;
      if (!merge) remember(doc.timeline);
      doc.lastKey = mergeKey ?? null;
      doc.lastKeyAt = now;
      doc.future = [];
      doc.external = null;
      doc.timeline = next;
      doc.dirty = true;
      scheduleSave();
      rerender();
    },
    [doc, canEdit, save],
  );

  const undo = useCallback(() => {
    if (!doc.timeline || !canEdit || !doc.past.length) return;
    const prev = doc.past.pop()!;
    doc.external = null;
    doc.future.push(doc.timeline);
    doc.timeline = prev;
    doc.lastKey = null;
    doc.dirty = true;
    scheduleSave();
    rerender();
  }, [doc, canEdit, save]);

  const redo = useCallback(() => {
    if (!doc.timeline || !canEdit || !doc.future.length) return;
    const next = doc.future.pop()!;
    doc.external = null;
    doc.past.push(doc.timeline);
    doc.timeline = next;
    doc.lastKey = null;
    doc.dirty = true;
    scheduleSave();
    rerender();
  }, [doc, canEdit, save]);

  // Check regularly for proxy/waveform progress, and as a backup for pushed changes.
  const busy = Object.values(doc.server?.media ?? {}).some((m) =>
    [m.proxy.status, m.peaks.status, m.transcript.status].some((s) => s === "queued" || s === "running"),
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, busy]);

  // Outside changes are pushed by the server the moment the file changes.
  useEffect(() => {
    const events = new EventSource(`/api/projects/${encodeURIComponent(name)}/events`);
    events.onmessage = () => void refresh();
    return () => events.close();
  }, [name, refresh]);

  // Warn before closing the tab with an unsaved change; save it right away on unmount.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (doc.dirty || doc.saving) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearTimeout(saveTimer.current);
      if (doc.dirty) void save();
    };
  }, [doc, save]);

  const saveState: SaveState = doc.saveError ? "error" : doc.saving ? "saving" : doc.dirty ? "pending" : "saved";

  return {
    server: doc.server,
    timeline: doc.timeline,
    errors: doc.server?.errors ?? [],
    loadError: doc.loadError,
    saveError: doc.saveError,
    saveState,
    notice: doc.notice,
    dismissNotice: () => {
      doc.notice = null;
      rerender();
    },
    /** Summary of the last outside change, or null. */
    external: doc.external,
    undoExternal: () => {
      if (doc.external) undo();
    },
    dismissExternal: () => {
      doc.external = null;
      rerender();
    },
    canEdit,
    canUndo: canEdit && doc.past.length > 0,
    canRedo: canEdit && doc.future.length > 0,
    applyEdit,
    undo,
    redo,
    refresh,
  };
}
