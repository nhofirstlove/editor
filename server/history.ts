// Timeline snapshots in projects/<name>/history/. Each is a full copy of timeline.json,
// named by local time and the reason it was taken, for example
// "2026-10-14_09-30-05_external.json". To roll back, copy one over timeline.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SnapshotReason =
  /** The file as it was just before an outside change (e.g. by Claude) replaced it. */
  | "external"
  /** Taken at most every 5 minutes while editing in the browser. */
  | "auto"
  /** Asked for with `npm run tl -- snapshot`. */
  | "manual"
  /** The file as it was before `npm run tl -- set` replaced it. */
  | "set"
  /** A version 1 file, kept the first time it's saved in the version 2 format. */
  | "upgrade";

export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** Writes a snapshot and returns its path. */
export async function saveSnapshot(projectDir: string, text: string, reason: SnapshotReason, now = new Date()): Promise<string> {
  const dir = path.join(projectDir, "history");
  await mkdir(dir, { recursive: true });
  const base = `${localStamp(now)}_${reason}`;
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? `${base}.json` : `${base}-${n}.json`);
    try {
      await writeFile(file, text, { flag: "wx" }); // never overwrite an existing snapshot
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Copies the current timeline.json into history/. */
export async function snapshotCurrent(projectDir: string, reason: SnapshotReason): Promise<string> {
  const text = await readFile(path.join(projectDir, "timeline.json"), "utf8");
  return saveSnapshot(projectDir, text, reason);
}

/** "2026-10-14_09-30-05" in local time. */
export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
