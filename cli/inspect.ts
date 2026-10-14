// Commands that look at a project: validate, summary, duration, snapshot, silences, words.

import path from "node:path";
import { layoutMain, layoutVoice, totalDuration } from "../schema/sequence.ts";
import { formatTimecode } from "../schema/timecode.ts";
import { hasAudio, round3 } from "../schema/timeline.ts";
import { wordsFor, wordsOnTimeline, wordTimelineStart } from "../schema/transcript.ts";
import { checkTools } from "../server/ffmpeg.ts";
import { snapshotCurrent } from "../server/history.ts";
import { detectSilences } from "../server/media.ts";
import { exists } from "../server/projects.ts";
import { readTranscript } from "../server/transcribe.ts";
import {
  allowOptions,
  CliError,
  loadTimeline,
  numberOption,
  output,
  readTimelineFile,
  resolveProject,
  shown,
  timelineFile,
  userCwd,
  type Args,
} from "./common.ts";
import { formatDuration, formatSummary, summaryData } from "./format.ts";

export async function validate(args: Args): Promise<void> {
  allowOptions(args, ["project"]);
  const file = args.positional[0] ? path.resolve(userCwd, args.positional[0]) : timelineFile((await resolveProject(args)).dir);
  const result = await readTimelineFile(file);
  if (!result.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, file, errors: result.errors }, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new CliError(`${file} has ${result.errors.length} problem(s). Fix them, then run validate again:\n- ${result.errors.join("\n- ")}`);
  }
  const tl = result.timeline;
  output(args, `OK: ${shown(file)} is valid (${formatDuration(tl)}).`, {
    ok: true,
    file,
    duration: round3(totalDuration(layoutMain(tl))),
    clips: tl.tracks.main.length,
  });
}

export async function summary(args: Args): Promise<void> {
  allowOptions(args, ["project"]);
  const { name, dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  output(args, formatSummary(tl, name), summaryData(tl, name));
}

export async function duration(args: Args): Promise<void> {
  allowOptions(args, ["project"]);
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  const seconds = totalDuration(layoutMain(tl));
  output(args, formatDuration(tl), { seconds: round3(seconds), timecode: formatTimecode(seconds, tl.fps ?? 25), clips: tl.tracks.main.length });
}

export async function snapshot(args: Args): Promise<void> {
  allowOptions(args, ["project"]);
  const { dir } = await resolveProject(args);
  const file = await snapshotCurrent(dir, "manual");
  output(
    args,
    [`Saved snapshot: ${shown(file)}`, "To roll back, copy it over timeline.json (the editor picks up the change, and can undo it)."],
    { file },
  );
}

export async function silences(args: Args): Promise<void> {
  allowOptions(args, ["project", "min", "db", "source"]);
  const minSeconds = numberOption(args, "min", 0.6);
  const noiseDb = numberOption(args, "db", -35);
  if (minSeconds <= 0) throw new CliError("--min must be more than 0 seconds.");
  if (noiseDb >= 0) throw new CliError("--db must be negative, for example -35 (quieter than -35 dB counts as silence).");
  const tools = checkTools();
  if (!tools.ok) throw new CliError(tools.message);
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  const wanted = args.options.get("source");
  // Default: the sources used on the main track (all sources if it's empty).
  const used = new Set(tl.tracks.main.map((c) => c.sourceId));
  const sources = wanted ? tl.sources.filter((s) => s.id === wanted) : tl.sources.filter((s) => used.size === 0 || used.has(s.id));
  if (wanted && sources.length === 0) {
    throw new CliError(`There is no source "${wanted}". Sources: ${tl.sources.map((s) => s.id).join(", ") || "none"}.`);
  }
  const results: Array<{ sourceId: string; start: number; end: number; duration: number }> = [];
  for (const s of sources) {
    if (!hasAudio(s)) {
      console.error(`${s.id} (${s.path}) has no audio, so it was skipped.`);
      continue;
    }
    const file = path.join(dir, s.path);
    if (!(await exists(file))) throw new CliError(`The media file ${s.path} for ${s.id} is missing from the project folder.`);
    const found = await detectSilences(file, minSeconds, noiseDb, s.duration ?? Infinity);
    console.error(`${s.id}: ${found.length} pause(s) of ${minSeconds} s or longer, quieter than ${noiseDb} dB`);
    results.push(...found.map((f) => ({ sourceId: s.id, ...f })));
  }
  console.log(JSON.stringify(results, null, 2));
}

export async function words(args: Args): Promise<void> {
  allowOptions(args, ["project", "from", "to", "source"]);
  const from = numberOption(args, "from", 0);
  const to = numberOption(args, "to", Infinity);
  if (!(to > from)) throw new CliError("--to must be later than --from.");
  const { dir } = await resolveProject(args);
  const tl = await loadTimeline(timelineFile(dir));
  const { transcript, error } = await readTranscript(dir);
  if (error) throw new CliError(error);
  const placed = layoutMain(tl);
  const voicePlaced = layoutVoice(tl);
  const noTranscript = (id: string, file: string) =>
    `There's no transcript for ${id} (${file}) yet. Transcribe it in the editor's Transcript tab or with \`npm run tl -- transcribe --source ${id}\`.`;

  const sourceId = args.options.get("source");
  if (sourceId) {
    // Source time: every word in the range, including ones cut from the edit.
    const source = tl.sources.find((s) => s.id === sourceId);
    if (!source) throw new CliError(`There is no source "${sourceId}". Sources: ${tl.sources.map((s) => s.id).join(", ") || "none"}.`);
    const list = wordsFor(transcript, source.id, source.path);
    if (!list) throw new CliError(noTranscript(source.id, source.path));
    const found = list
      .filter((w) => w.end > from && w.start < to)
      .map((w) => {
        const main = wordTimelineStart(placed, source.id, w);
        const at = main ?? wordTimelineStart(voicePlaced, source.id, w);
        const track = at === null ? null : main !== null ? "main" : "voice";
        return { text: w.text, start: w.start, end: w.end, inEdit: at !== null, track, timelineStart: at === null ? null : round3(at) };
      });
    const range = Number.isFinite(to) ? `between ${from} and ${to} s` : `from ${from} s`;
    console.error(`${found.length} words in ${source.id} ${range} of SOURCE time. Words not in the edit have "inEdit": false (shown [in brackets]).`);
    if (found.length) console.error(`Text: ${found.map((w) => (w.inEdit ? w.text : `[${w.text}]`)).join(" ")}`);
    console.log(JSON.stringify(found, null, 2));
    return;
  }

  // Timeline time: the words as they play in the edit, on the main track and the voiceover.
  const bySource: Record<string, ReturnType<typeof wordsFor>> = {};
  for (const s of tl.sources) {
    if (![...placed, ...voicePlaced].some((p) => p.clip.sourceId === s.id)) continue;
    bySource[s.id] = wordsFor(transcript, s.id, s.path);
    if (!bySource[s.id] && hasAudio(s)) console.error(`Note: ${noTranscript(s.id, s.path)} Its words aren't listed.`);
  }
  if (!Object.values(bySource).some(Boolean)) {
    throw new CliError("None of the files in the edit has a transcript yet. Transcribe them in the editor's Transcript tab or with `npm run tl -- transcribe`.");
  }
  const onTrack = (track: "main" | "voice", list: ReturnType<typeof wordsOnTimeline>) =>
    list
      .filter((w) => w.timelineEnd > from && w.timelineStart < to)
      .map((w) => ({
        text: w.text,
        start: round3(w.timelineStart),
        end: round3(w.timelineEnd),
        track,
        clipId: w.clipId,
        sourceId: w.sourceId,
        sourceStart: w.start,
        sourceEnd: w.end,
      }));
  // Main-track words first, then voiceover words, each in playback order.
  const found = [...onTrack("main", wordsOnTimeline(placed, bySource)), ...onTrack("voice", wordsOnTimeline(voicePlaced, bySource))];
  const range = Number.isFinite(to) ? `between ${from} and ${to} s` : `from ${from} s`;
  console.error(
    `${found.length} words ${range} of TIMELINE time ("start"/"end"); "sourceStart"/"sourceEnd" are source seconds; "track" is main or voice.`,
  );
  if (found.length) console.error(`Text: ${found.map((w) => w.text).join(" ")}`);
  console.log(JSON.stringify(found, null, 2));
}
