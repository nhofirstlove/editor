#!/usr/bin/env node
// Stop hook: when Claude finishes a turn with TypeScript files changed (compared with
// the last commit), runs `npm run typecheck` (about 2 s). If it fails, exit code 2 sends
// the errors back so Claude fixes them before handing over. Turns that didn't touch
// TypeScript cost nothing.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // Run anyway with defaults.
}

// Claude is already continuing because of this hook: don't loop.
if (input.stop_hook_active) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
if (status.status !== 0) process.exit(0); // Not a git checkout or git missing: skip quietly.
const changedTs = status.stdout
  .split(/\r?\n/)
  .map((line) => line.slice(3).trim())
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("projects/"));
if (changedTs.length === 0) process.exit(0);

const check = spawnSync("npm run --silent typecheck", { cwd, shell: true, encoding: "utf8", timeout: 120_000 });
if (check.status === 0) process.exit(0);

const output = `${check.stdout ?? ""}${check.stderr ?? ""}`.trim();
process.stderr.write(
  `Type check failed after changes to ${changedTs.length} TypeScript file(s). Fix these before finishing:\n` +
    `${output.slice(0, 4000) || "(no output)"}\n`,
);
process.exit(2);
