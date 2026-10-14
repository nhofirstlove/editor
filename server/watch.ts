// Watches every project's timeline.json, so changes made outside the editor (by Claude,
// a text editor, or the CLI) reach the browser within about a second.

import path from "node:path";
import { watch } from "chokidar";

/**
 * Calls `onChange(projectDir)` whenever projects/<name>/timeline.json appears or
 * changes, including once for each existing file when watching starts.
 */
export function watchTimelines(projectsDir: string, onChange: (projectDir: string) => void) {
  const watcher = watch(projectsDir, {
    depth: 1,
    // Only project folders and their timeline.json; never media/ or generated folders.
    ignored: (p) => {
      const parts = path.relative(projectsDir, p).split(path.sep).filter(Boolean);
      return parts.length > 2 || (parts.length === 2 && parts[1] !== "timeline.json");
    },
    // Wait until a write has finished, so a half-written file is never read.
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  const handle = (file: string) => {
    if (path.basename(file) === "timeline.json") onChange(path.dirname(file));
  };
  watcher.on("add", handle).on("change", handle);
  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return { ready, close: () => watcher.close() };
}
