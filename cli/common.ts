// Shared plumbing for the `tl` command line: arguments, picking the project, reading
// the timeline, and printing results for people (text) or programs (--json).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTimelineJson, type Timeline } from "../schema/timeline.ts";
import { checkProjectName, exists, listProjects } from "../server/projects.ts";

/** A problem the person can fix; printed without a stack trace. */
export class CliError extends Error {}

export const projectsDir = path.resolve(process.env.PROJECTS_DIR ?? fileURLToPath(new URL("../projects/", import.meta.url)));
// npm runs scripts from the repository root; INIT_CWD is where the command was typed.
export const userCwd = process.env.INIT_CWD ?? process.cwd();

/** A path relative to where the command was typed, or the full path if it's elsewhere. */
export function shown(p: string): string {
  const rel = path.relative(userCwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

export type Args = { command: string; positional: string[]; options: Map<string, string>; json: boolean };

/** Options that are switches and take no value. */
const FLAGS = new Set(["json", "final", "preview"]);

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-p" || arg.startsWith("--")) {
      const [key, inline] = arg === "-p" ? ["project", undefined] : arg.slice(2).split(/=(.*)/s, 2);
      if (FLAGS.has(key) && inline === undefined) {
        options.set(key, "true");
        continue;
      }
      const value = inline ?? rest[++i];
      if (value === undefined) throw new CliError(`"${arg}" needs a value, for example ${arg} 0.6`);
      options.set(key, value);
    } else positional.push(arg);
  }
  return { command, positional, options, json: options.has("json") };
}

/** Rejects options a command doesn't know. --json is accepted everywhere. */
export function allowOptions(args: Args, allowed: string[]): void {
  for (const key of args.options.keys()) {
    if (key !== "json" && !allowed.includes(key)) {
      const list = allowed.length ? `Options for "${args.command}": ${allowed.map((a) => `--${a}`).join(", ")}.` : `"${args.command}" takes no options.`;
      throw new CliError(`Unknown option --${key}. ${list}`);
    }
  }
}

export function numberOption(args: Args, key: string, fallback: number): number {
  const raw = args.options.get(key);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new CliError(`--${key} must be a number (got "${raw}").`);
  return v;
}

/** Prints a result: `data` as JSON with --json, otherwise the human-readable text. */
export function output(args: Args, text: string | string[], data: unknown): void {
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else console.log(Array.isArray(text) ? text.join("\n") : text);
}

/** Reports progress (0..1) on stderr every 10%, so stdout stays clean for --json. */
export function progressPrinter(label: string): (p: number) => void {
  let shownPercent = -10;
  return (p) => {
    const percent = Math.floor(p * 100);
    if (percent >= shownPercent + 10) {
      shownPercent = percent - (percent % 10);
      console.error(`${label}… ${shownPercent}%`);
    }
  };
}

/** Picks the project: --project, else the folder the command was run from, else the only project. */
export async function resolveProject(args: Args): Promise<{ name: string; dir: string }> {
  let name = args.options.get("project");
  if (!name) {
    const rel = path.relative(projectsDir, userCwd);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) name = rel.split(path.sep)[0];
  }
  if (!name) {
    const projects = await listProjects(projectsDir);
    if (projects.length === 0) throw new CliError(`There are no projects yet in ${projectsDir}. Create one with \`npm run tl -- new <name>\`.`);
    if (projects.length > 1) {
      throw new CliError(
        `There are several projects (${projects.join(", ")}). Say which one with --project, for example:\n` +
          `  npm run tl -- ${args.command} --project ${projects[0]}`,
      );
    }
    name = projects[0];
  }
  try {
    checkProjectName(name);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const dir = path.join(projectsDir, name);
  if (!(await exists(path.join(dir, "timeline.json")))) {
    throw new CliError(`There is no project called "${name}" (looked for ${path.join(dir, "timeline.json")}).`);
  }
  return { name, dir };
}

/** Reads and validates a timeline file, or explains what's wrong with it. */
export async function loadTimeline(file: string): Promise<Timeline> {
  const result = await readTimelineFile(file);
  if (!result.ok) {
    throw new CliError(`${file} has ${result.errors.length} problem(s). Fix them, then run validate again:\n- ${result.errors.join("\n- ")}`);
  }
  return result.timeline;
}

export async function readTimelineFile(file: string) {
  const text = await readFile(file, "utf8").catch(() => {
    throw new CliError(`Can't read ${file}. Check the path.`);
  });
  return parseTimelineJson(text);
}

export function timelineFile(dir: string): string {
  return path.join(dir, "timeline.json");
}
