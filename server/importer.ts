// Importing a file into a project, shared by the browser upload (server) and
// `npm run tl -- import` (CLI): copy it next to media/, check it with ffprobe, move it
// into media/ under a safe unique name, and add it to the timeline.

import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Timeline } from "../schema/timeline.ts";
import { probe } from "./ffmpeg.ts";
import {
  addImportedSource,
  checkFreeSpace,
  mediaFileName,
  readTimeline,
  UserError,
  withLock,
  type ImportedSource,
  type ImportPlacement,
} from "./projects.ts";

/** Image formats the export can't use as stills (animated, or not read by every ffmpeg). */
const UNSUPPORTED_IMAGE = /\.(gif|heic|heif|avif)$/i;

export type ImportInput = {
  /** The file's original name, used for the name in media/. */
  name: string;
  /** Size in bytes, for the disk-space check (skipped when unknown). */
  size?: number;
  /** Writes the file's bytes to `tmp`. */
  write: (tmp: string) => Promise<void>;
};

/**
 * Imports one file. `save` writes the new timeline: the server passes its own save (so
 * the file watcher knows the change is its own); the CLI writes the file directly.
 */
export async function importMedia(
  dir: string,
  input: ImportInput,
  placement: ImportPlacement,
  save: (dir: string, timeline: Timeline) => Promise<unknown>,
): Promise<ImportedSource> {
  if (UNSUPPORTED_IMAGE.test(input.name)) {
    throw new UserError(`"${input.name}" is a kind of image the editor can't use. Save it as PNG or JPEG and import that instead.`);
  }
  const current = await readTimeline(dir);
  if (!current.ok) throw timelineBroken(current.errors);
  if (input.size && input.size > 0) await checkFreeSpace(dir, input.size);

  // Copy to a temp file outside media/, so media/ never holds a half-written file.
  const tmp = path.join(dir, `.import-${randomUUID()}${path.extname(input.name).slice(0, 10)}`);
  try {
    try {
      await input.write(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new UserError("The drive ran out of space while copying the file, so nothing was imported. Free up some space and try again.", 507);
      }
      throw new UserError(`Copying "${input.name}" was interrupted, so nothing was imported. Try the import again.`);
    }

    const info = await probe(tmp).catch((err: Error) => {
      throw new UserError(`"${input.name}" can't be imported: ${err.message}`);
    });
    if (!info.hasVideo && info.audioChannels === 0) {
      throw new UserError(`"${input.name}" has neither picture nor sound, so there is nothing to import.`);
    }
    return await withLock(dir, async () => {
      // Re-read: the timeline may have changed while the file was copying.
      const fresh = await readTimeline(dir);
      if (!fresh.ok) throw timelineBroken(fresh.errors);
      const fileName = await mediaFileName(dir, input.name);
      // Worked out (and the placement checked) before anything lands in media/.
      const result = addImportedSource(fresh.timeline, `media/${fileName}`, info, placement);
      await rename(tmp, path.join(dir, "media", fileName));
      await save(dir, result.timeline);
      return result;
    });
  } finally {
    await rm(tmp, { force: true });
  }
}

export function timelineBroken(errors: string[], what = "Nothing was imported"): UserError {
  return new UserError(
    `${what} because timeline.json has errors. Fix them first (the banner at the top lists them):\n- ${errors.join("\n- ")}`,
    409,
    "invalid-file",
  );
}
