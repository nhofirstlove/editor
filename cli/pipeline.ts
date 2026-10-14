// Commands that build and deliver a project without the browser or the server, for an
// automated pipeline (or a person at a terminal): new, import, set, transcribe, export,
// handoff. A running editor picks up their changes like any outside edit.

import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { layoutMain, totalDuration } from "../schema/sequence.ts";
import { formatTimecode } from "../schema/timecode.ts";
import { hasAudio, round3 } from "../schema/timeline.ts";
import { wordsFor } from "../schema/transcript.ts";
import { newExportName, runExport, type Preset } from "../server/export.ts";
import { checkTools } from "../server/ffmpeg.ts";
import { writeOtio } from "../server/handoff.ts";
import { importMedia } from "../server/importer.ts";
import { createProject, exists, writeTimeline, type ImportPlacement } from "../server/projects.ts";
import { checkTranscriber, readTranscript, transcribeSource } from "../server/transcribe.ts";
import {
  allowOptions,
  CliError,
  loadTimeline,
  numberOption,
  output,
  progressPrinter,
  projectsDir,
  readTimelineFile,
  resolveProject,
  shown,
  timelineFile,
  userCwd,
  type Args,
} from "./common.ts";

function requireTools(): void {
  const tools = checkTools();
  if (!tools.ok) throw new CliError(tools.message);
}

export async function newProject(args: Args): Promise<void> {
  allowOptions(args, []);
  const name = args.positional[0];
  if (!name) throw new CliError("Give the new project a name, for example: npm run tl -- new client-interview-oct");
  await createProject(projectsDir, name);
  const dir = path.join(projectsDir, name);
  output(args, `Created ${shown(dir)} (media/, timeline.json and the generated folders).`, { project: name, dir });
}

export async function importFiles(args: Args): Promise<void> {
  allowOptions(args, ["project", "to", "at"]);
  if (args.positional.length === 0) throw new CliError("Name one or more files to import, for example: npm run tl -- import interview.mp4");
  const to = args.options.get("to");
  if (to !== undefined && !["main", "voice", "music", "none"].includes(to)) throw new CliError(`--to must be main, voice, music or none (got "${to}").`);
  const at = args.options.has("at") ? numberOption(args, "at", 0) : undefined;
  const placement: ImportPlacement = { to: to as ImportPlacement["to"], at };
  requireTools();
  const { dir } = await resolveProject(args);

  const results = [];
  for (const arg of args.positional) {
    const file = path.resolve(userCwd, arg);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new CliError(`Can't find the file ${file}. Check the path.`);
    const { source, clip } = await importMedia(
      dir,
      { name: path.basename(file), size: info.size, write: (tmp) => copyFile(file, tmp) },
      placement,
      (d, timeline) => writeTimeline(d, timeline),
    );
    results.push({ file, sourceId: source.id, path: source.path, clipId: clip?.id ?? null, track: clip?.track ?? null });
    if (!args.json) {
      const where = clip ? `clip ${clip.id} on the ${clip.track} track` : "no clip (source only)";
      console.log(`Imported ${path.basename(file)} as ${source.id} (${source.path}), ${where}.`);
    }
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
}

/** Replaces the project's timeline with a file the pipeline wrote, after checking it. */
export async function setTimeline(args: Args): Promise<void> {
  allowOptions(args, ["project", "file"]);
  const given = args.options.get("file");
  if (!given) throw new CliError("Say which timeline file to use: npm run tl -- set --file assembled.json");
  const file = path.resolve(userCwd, given);
  const result = await readTimelineFile(file);
  if (!result.ok) throw new CliError(`${file} has ${result.errors.length} problem(s), so nothing was changed:\n- ${result.errors.join("\n- ")}`);
  const { name, dir } = await resolveProject(args);

  const missing: string[] = [];
  for (const s of result.timeline.sources) if (!(await exists(path.join(dir, s.path)))) missing.push(`${s.id}: ${s.path}`);
  if (missing.length) {
    throw new CliError(
      `Nothing was changed: these files aren't in ${name}'s media folder yet:\n- ${missing.join("\n- ")}\n` +
        "Import them first, for example: npm run tl -- import shot.mp4 --to none",
    );
  }
  const timeline = { ...result.timeline, project: result.timeline.project ?? name };
  await writeTimeline(dir, timeline, { snapshot: "set" });
  const seconds = totalDuration(layoutMain(timeline));
  output(
    args,
    `Timeline replaced from ${shown(file)}: ${timeline.tracks.main.length} clips, ${formatTimecode(seconds, timeline.fps ?? 25)}. The previous version is in history/.`,
    { ok: true, project: name, clips: timeline.tracks.main.length, duration: round3(seconds) },
  );
}

export async function transcribe(args: Args): Promise<void> {
  allowOptions(args, ["project", "source"]);
  requireTools();
  const transcriber = await checkTranscriber();
  if (!transcriber.ok) throw new CliError(transcriber.message);
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  const before = await readTranscript(dir);

  // Default: the voiceover's files when there is a voiceover (the pipeline's narration);
  // otherwise every file with sound. Either way, only files without a transcript yet.
  const wanted = args.options.get("source");
  const voiceIds = new Set((tl.tracks.voice ?? []).map((v) => v.sourceId));
  let sources = tl.sources.filter(
    (s) => hasAudio(s) && (voiceIds.size === 0 || voiceIds.has(s.id)) && !wordsFor(before.transcript, s.id, s.path),
  );
  if (wanted) {
    const source = tl.sources.find((s) => s.id === wanted);
    if (!source) throw new CliError(`There is no source "${wanted}". Sources: ${tl.sources.map((s) => s.id).join(", ") || "none"}.`);
    if (!hasAudio(source)) throw new CliError(`${source.id} (${source.path}) has no audio track, so there is nothing to transcribe.`);
    sources = [source];
  }
  if (sources.length === 0) {
    const which = voiceIds.size ? "Every voiceover file" : "Every file with sound";
    output(args, `${which} already has a transcript. Use --source <id> to transcribe another file, or one again.`, []);
    return;
  }
  for (const s of sources) {
    await transcribeSource(dir, s, progressPrinter(`Transcribing ${s.id}`), (note) => console.error(note));
  }
  const after = await readTranscript(dir);
  const results = sources.map((s) => {
    const entry = after.transcript?.sources?.[s.id];
    return { sourceId: s.id, path: s.path, words: entry?.words.length ?? 0, language: entry?.language ?? null };
  });
  output(
    args,
    results.map((r) => `Transcribed ${r.sourceId} (${r.path}): ${r.words} words${r.language ? `, language ${r.language}` : ""}.`),
    results,
  );
}

export async function exportVideo(args: Args, forced?: Preset): Promise<void> {
  allowOptions(args, forced ? ["project", "out"] : ["project", "final", "preview", "out"]);
  const final = args.options.has("final");
  const previewFlag = args.options.has("preview");
  if (!forced && final === previewFlag) throw new CliError("Say which export you want: --final (full quality) or --preview (quick 720p).");
  const preset: Preset = forced ?? (final ? "final" : "preview");
  requireTools();
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  if (tl.tracks.main.length === 0) throw new CliError("There is nothing to export yet: the timeline has no clips.");

  const name = await newExportName(dir, tl, preset);
  const result = await runExport(dir, tl, preset, name, progressPrinter("Rendering")).catch((err: Error) => {
    throw new CliError(err.message);
  });
  const rendered = path.join(dir, "exports", result.file);
  const outArg = args.options.get("out");
  const copied = outArg ? path.resolve(userCwd, outArg) : null;
  if (copied) {
    await copyFile(rendered, copied).catch((err: Error) => {
      throw new CliError(`The export is in ${shown(rendered)}, but copying it to ${copied} failed: ${err.message}`);
    });
  }

  const offBy = Math.abs(result.duration - result.expectedDuration);
  const allowed = tl.tracks.main.length / (tl.fps ?? 25);
  const lines = [
    `Saved ${shown(rendered)}${copied ? ` (and a copy at ${shown(copied)})` : ""}`,
    `Length ${result.duration.toFixed(3)} s; timeline ${result.expectedDuration.toFixed(3)} s (difference ${offBy.toFixed(3)} s).`,
  ];
  if (offBy > allowed) lines.push(`Warning: that's more than one frame per clip (${allowed.toFixed(3)} s). Check the export.`);
  lines.push(`ffmpeg command: ${shown(path.join(dir, "exports", result.commandFile))}`);
  output(args, lines, {
    preset,
    file: rendered,
    copy: copied,
    duration: result.duration,
    expectedDuration: round3(result.expectedDuration),
    withinOneFramePerClip: offBy <= allowed,
    commandFile: path.join(dir, "exports", result.commandFile),
  });
}

export async function handoff(args: Args): Promise<void> {
  allowOptions(args, ["project"]);
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  const file = path.join(dir, "exports", await writeOtio(dir, tl).catch((err: Error) => {
    throw new CliError(err.message);
  }));
  output(args, [`Saved ${shown(file)}`, "Open it in DaVinci Resolve with File → Import → Timeline…"], { file });
}
