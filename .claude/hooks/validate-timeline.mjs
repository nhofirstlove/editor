#!/usr/bin/env node
// PostToolUse hook: validates timeline.json every time Claude edits or writes it.
// - If the app's CLI exists (an "tl" script in package.json), it runs
//   `npm run tl -- validate <file>` so the app's own zod schema is the judge.
// - Until then, it runs the built-in checks below, which follow SPEC.md section 5.
// Exit code 2 sends the errors back to Claude so it fixes them before answering.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const args = input.tool_input ?? {};
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const rawPath = args.file_path ?? "";
if (!/(^|[\\/])timeline\.json$/i.test(rawPath)) process.exit(0);
const file = path.isAbsolute(rawPath) ? rawPath : path.join(projectDir, rawPath);
if (!existsSync(file)) process.exit(0);

function fail(lines) {
  process.stderr.write(
    `timeline.json failed validation (${path.relative(projectDir, file) || file}):\n` +
      lines.map((l) => `  - ${l}`).join("\n") +
      "\nFix these before finishing. The editor keeps showing the last valid version until the file is valid.\n"
  );
  process.exit(2);
}

// 1. Prefer the app's own validator once it exists.
const pkgPath = path.join(projectDir, "package.json");
if (existsSync(pkgPath)) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch {}
  if (pkg.scripts?.tl) {
    const run = spawnSync(`npm run --silent tl -- validate "${file}"`, {
      cwd: projectDir, shell: true, encoding: "utf8", timeout: 60_000,
    });
    if (run.status === 0) process.exit(0);
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    fail([out || `validator exited with code ${run.status}`]);
  }
}

// 2. Built-in checks (used until the app's CLI is built).
let tl;
try {
  tl = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  fail([`not valid JSON: ${e.message}`]);
}

const errors = [];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const tooPrecise = (v) => isNum(v) && Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6;

if (tl.version !== 1) errors.push(`"version" must be 1 (found ${JSON.stringify(tl.version)})`);
if (!Array.isArray(tl.sources)) errors.push(`"sources" must be an array`);
if (!tl.tracks || !Array.isArray(tl.tracks.main)) errors.push(`"tracks.main" must be an array`);
if (tl.tracks?.music !== undefined && !Array.isArray(tl.tracks.music)) {
  errors.push(`"tracks.music" must be an array when present`);
}

const sources = new Map();
for (const [i, s] of (Array.isArray(tl.sources) ? tl.sources : []).entries()) {
  const where = `sources[${i}]`;
  if (typeof s?.id !== "string" || !s.id) { errors.push(`${where}: "id" must be a non-empty string`); continue; }
  if (sources.has(s.id)) errors.push(`${where}: duplicate source id "${s.id}"`);
  if (typeof s.path !== "string" || !s.path) errors.push(`${where}: "path" must be a non-empty string`);
  if (s.duration !== undefined && !(isNum(s.duration) && s.duration > 0)) {
    errors.push(`${where}: "duration" must be a positive number`);
  }
  sources.set(s.id, s);
}

const ids = new Set();
function checkClip(c, where, kind) {
  if (typeof c?.id !== "string" || !c.id) { errors.push(`${where}: "id" must be a non-empty string`); return; }
  where = `${where} (id "${c.id}")`;
  if (ids.has(c.id)) errors.push(`${where}: duplicate clip id; every clip needs a unique id`);
  ids.add(c.id);

  const src = sources.get(c.sourceId);
  if (!src) errors.push(`${where}: "sourceId" ${JSON.stringify(c.sourceId)} does not match any source`);

  if (!isNum(c.in) || !isNum(c.out)) {
    errors.push(`${where}: "in" and "out" must be numbers (seconds)`);
  } else {
    if (c.in < 0) errors.push(`${where}: "in" (${c.in}) must be >= 0`);
    if (c.in >= c.out) errors.push(`${where}: "in" (${c.in}) must be less than "out" (${c.out})`);
    if (isNum(src?.duration) && c.out > src.duration + 0.001) {
      errors.push(`${where}: "out" (${c.out}) is past the end of source "${src.id}" (${src.duration}s)`);
    }
  }
  for (const key of ["in", "out", "start", "fadeIn", "fadeOut"]) {
    if (tooPrecise(c[key])) errors.push(`${where}: "${key}" (${c[key]}) must be rounded to 3 decimals`);
  }
  if (c.volume !== undefined && !(isNum(c.volume) && c.volume >= 0 && c.volume <= 2)) {
    errors.push(`${where}: "volume" must be between 0.0 and 2.0 (found ${JSON.stringify(c.volume)})`);
  }

  if (kind === "main") {
    if (c.speed !== undefined && !(isNum(c.speed) && c.speed >= 0.25 && c.speed <= 4)) {
      errors.push(`${where}: "speed" must be between 0.25 and 4.0 (found ${JSON.stringify(c.speed)})`);
    }
    if (c.muted !== undefined && typeof c.muted !== "boolean") errors.push(`${where}: "muted" must be true or false`);
    if (c.start !== undefined) errors.push(`${where}: main-track clips must not have "start"; their position comes from clip order`);
  } else {
    if (!(isNum(c.start) && c.start >= 0)) errors.push(`${where}: music clips need "start" >= 0 (timeline seconds)`);
    for (const key of ["fadeIn", "fadeOut"]) {
      if (c[key] !== undefined && !(isNum(c[key]) && c[key] >= 0)) errors.push(`${where}: "${key}" must be >= 0`);
    }
  }
}

(tl.tracks?.main ?? []).forEach((c, i) => checkClip(c, `tracks.main[${i}]`, "main"));
(Array.isArray(tl.tracks?.music) ? tl.tracks.music : []).forEach((c, i) => checkClip(c, `tracks.music[${i}]`, "music"));

if (errors.length) fail(errors);
process.exit(0);
