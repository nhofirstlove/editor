// Timeline helpers for Claude, pipelines and people: `npm run tl -- <command> [options]`.
// Run `npm run tl -- help` for the list of commands.

import { UserError } from "../server/projects.ts";
import { CliError, parseArgs, type Args } from "./common.ts";
import { duration, silences, snapshot, summary, validate, words } from "./inspect.ts";
import { exportVideo, handoff, importFiles, newProject, setTimeline, transcribe } from "./pipeline.ts";

const USAGE = `Timeline helpers. Usage: npm run tl -- <command> [options]

Look at a project:
  validate [path]        Check a timeline file (default: the project's timeline.json)
  summary                Table of clips with source and timeline times
  duration               Total timeline duration
  silences [--min 0.6] [--db -35] [--source src1]
                         Pauses in the source audio, as JSON (source seconds)
  words [--from 30] [--to 60] [--source src1]
                         Transcribed words as JSON. Without --source: the words that
                         play in the edit (main track and voiceover), in timeline
                         seconds. With --source: every word of that file in source
                         seconds, marking ones cut out
  snapshot               Save a copy of timeline.json to history/

Build and deliver (no editor or server needed):
  new <name>             Create a project
  import <files…> [--to main|voice|music|none] [--at <seconds>]
                         Copy files into media/ and add them: video to the end of the
                         main track, audio to the music track (at --at, default 0) or
                         the voiceover track (at --at, default after the last one), or
                         source only
  set --file <timeline.json>
                         Replace the timeline with a checked file (previous one kept
                         in history/)
  transcribe [--source src1]
                         Transcribe files that have no transcript yet: the voiceover's
                         files, or every file with sound when there's no voiceover
  export --final|--preview [--out <file>]
                         Render the edit to exports/ and check its length
  preview                Same as export --preview
  handoff                Write an .otio file for DaVinci Resolve to exports/

Options:
  --project <name>, -p <name>
      Which project to use. Not needed when there is only one project, or when you
      run the command from inside a project folder.
  --json
      Print the result as JSON (for programs). Errors are printed as
      {"ok": false, "error": "..."} and the exit code is 1.`;

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  validate,
  summary,
  duration,
  silences,
  words,
  snapshot,
  new: newProject,
  import: importFiles,
  set: setTimeline,
  transcribe,
  export: (args) => exportVideo(args),
  preview: (args) => exportVideo(args, "preview"),
  handoff,
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (["help", "--help", "-h"].includes(args.command)) {
    console.log(USAGE);
    return;
  }
  const command = COMMANDS[args.command];
  if (!command) throw new CliError(`Unknown command "${args.command}".\n\n${USAGE}`);
  await command(args);
}

main(process.argv.slice(2)).catch((err: Error) => {
  const known = err instanceof CliError || err instanceof UserError;
  const message = known ? err.message : `Something went wrong: ${err.message}`;
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  console.error(message);
  process.exit(1);
});
