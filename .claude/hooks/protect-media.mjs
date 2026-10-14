#!/usr/bin/env node
// PreToolUse hook: blocks any change to original footage in projects/<name>/media/.
// Claude Code sends the tool call as JSON on stdin. Exit code 2 blocks the call and
// shows the message on stderr to Claude. Exit code 0 lets the call through.
//
// Checks file tools (Edit, Write, ...) and shell tools (Bash, PowerShell). It is a
// safety net for Claude's own tool calls, not a sandbox: it can't follow a `cd` in the
// middle of a command, shell variables, or scripts. Keep a backup of client footage.

import { readFileSync } from "node:fs";
import path from "node:path";

// Matches projects/<name>/media in file paths and inside shell commands (/ or \).
const MEDIA_PATH = /(^|[\s"'=\\/])projects[\\/][^\\/\s"']+[\\/]media([\\/\s"';&|)]|$)/i;
// The projects folder itself or one whole project folder, e.g. `projects`, `projects/*`,
// `projects\client-interview-oct`. Deleting either deletes the footage inside.
const PROJECT_DIR = /(^|[\s"'=\\/])projects([\\/][^\\/\s"';&|)]+)?[\\/]?(?=[\s"';&|)]|$)/i;
// Shell commands (POSIX and PowerShell, including aliases) that delete, move, or rewrite files.
const CHANGES_FILES =
  /(^|[\s;&|(])(rm|rmdir|mv|unlink|truncate|shred|chmod|chown|sed\s+(-[a-z]*i[a-z]*|--in-place)|perl\s+-[a-z]*i|remove-item|ri|del|erase|rd|move-item|mi|move|rename-item|rni|ren|clear-content|clc|set-content|sc|add-content|ac|out-file|icacls|attrib)\b/i;
// Output redirection whose target is inside media/ (e.g. `> projects/x/media/a.mp4`).
const REDIRECT_INTO_MEDIA = />{1,2}\s*["']?[^\s"';&|]*projects[\\/][^\\/\s]+[\\/]media([\\/]|\s|$)/i;

// Per-command rules, matched against the command name of each part of a pipeline.
const DELETES_OR_MOVES = /^(rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred|mv|move|move-item|mi|ren|rename-item|rni)$/i;
const MOVES = /^(mv|move|move-item|mi|ren|rename-item|rni)$/i;
// Commands that write to their last argument (cp src dst). ffmpeg is handled separately.
const WRITES_LAST_ARG = /^(cp|copy|copy-item|cpi|rsync|scp|install|ln)$/i;

function block(reason) {
  process.stderr.write(
    `Blocked by protect-media hook: ${reason}\n` +
      "Files in projects/<name>/media/ are original footage and must never be changed. " +
      "Write proxies to proxies/, renders to exports/, and edits to timeline.json instead.\n"
  );
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // Not valid hook input; don't get in the way.
}

const tool = input.tool_name ?? "";
const args = input.tool_input ?? {};

if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const target = args.file_path ?? args.notebook_path ?? "";
  if (MEDIA_PATH.test(target)) block(`${tool} on ${target}`);
}

if (tool === "Bash" || tool === "PowerShell") checkShell(String(args.command ?? ""));

process.exit(0);

// Git Bash on Windows writes C:\x as /c/x; convert so Node can resolve it.
function toNativePath(p) {
  if (process.platform !== "win32") return p;
  return p.replace(/^\/([a-z])(\/|$)/i, (_, drive) => `${drive.toUpperCase()}:/`);
}

function checkShell(command) {
  const cwd = toNativePath(String(input.cwd ?? process.cwd()));
  const root = process.env.CLAUDE_PROJECT_DIR ? toNativePath(process.env.CLAUDE_PROJECT_DIR) : "";
  // Relative forms such as `cd projects/demo && rm media/a.mp4`, or `rm media/a.mp4`
  // run from inside a project folder.
  const insideProject = /[\\/]projects[\\/][^\\/]+([\\/]|$)/i.test(cwd);
  const relativeMediaCounts = insideProject || /projects[\\/]/i.test(command);
  const isMedia = (token) =>
    MEDIA_PATH.test(token) || (relativeMediaCounts && /^(\.[\\/])?media([\\/]|$)/i.test(token));

  // Reading footage is fine (ffprobe, ffmpeg -i, cp out of media/). Changing it is not.
  const mentionsMedia =
    MEDIA_PATH.test(command) ||
    (relativeMediaCounts && /(^|[\s"'=])(\.[\\/])?media([\\/\s"';&|)]|$)/i.test(command));
  if (mentionsMedia && CHANGES_FILES.test(command)) {
    block(`shell command could change media/: ${command}`);
  }
  if (REDIRECT_INTO_MEDIA.test(command)) {
    block(`shell output redirected into media/: ${command}`);
  }
  // Everything under projects/ is git-ignored, so these git commands delete footage.
  if (/\bgit\s+clean\b[^;&|\n]*\s-[a-zA-Z]*[xX]/.test(command) && !/\s(-[a-zA-Z]*n[a-zA-Z]*|--dry-run)\b/.test(command)) {
    block(`git clean -x/-X deletes git-ignored files, and projects/ (all footage) is git-ignored: ${command}`);
  }
  if (/\bgit\s+stash\b[^;&|\n]*\s(-[a-zA-Z]*a\b|--all\b)/.test(command)) {
    block(`git stash --all removes git-ignored files, and projects/ (all footage) is git-ignored: ${command}`);
  }

  // Would deleting or moving this path take footage with it?
  function containsFootage(target) {
    if (PROJECT_DIR.test(target) || isMedia(target)) return true;
    if (!root) return false;
    const projectsDir = path.resolve(root, "projects");
    const resolved = path.resolve(cwd, toNativePath(target).replace(/(^|[\\/])\*+$/, "") || ".");
    // projects/ itself, or a folder that contains it (`.`, `*`, `..`, the repo root).
    const up = path.relative(resolved, projectsDir);
    if (up === "" || (!up.startsWith("..") && !path.isAbsolute(up))) return true;
    // One whole project folder, or anything inside a media folder.
    const down = path.relative(projectsDir, resolved);
    if (down && !down.startsWith("..") && !path.isAbsolute(down)) {
      const parts = down.split(/[\\/]/);
      if (parts.length === 1 || parts[1].toLowerCase() === "media") return true;
    }
    return false;
  }

  // Check each command in the line (split at ;, &&, ||, | and newlines).
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = part.trim().split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, "")).filter(Boolean);
    while (tokens.length && /^(sudo|nohup|time|command|exec|&)$/i.test(tokens[0])) tokens.shift();
    if (!tokens.length) continue;
    const name = tokens[0].split(/[\\/]/).pop().replace(/\.exe$/i, "");
    const rest = tokens.slice(1);
    // Flags look like -r, --force, -Recurse, or cmd-style /s.
    const positional = rest.filter((t) => !/^-/.test(t) && !/^\/[a-z?]$/i.test(t));

    // ffmpeg reads the files after -i and writes every other file argument.
    if (name === "ffmpeg") {
      const output = rest.find((t, i) => isMedia(t) && !/^-i$/i.test(rest[i - 1] ?? ""));
      if (output) block(`ffmpeg output into media/: ${output}`);
      continue;
    }

    // Where a copy/move writes: -Destination X, -t X, --target-directory=X, else the last argument.
    let dest = positional[positional.length - 1];
    rest.forEach((t, i) => {
      if (/^(-destination|-t|--target-directory)$/i.test(t) && rest[i + 1]) dest = rest[i + 1];
      if (/^--target-directory=/i.test(t)) dest = t.split("=")[1];
    });

    if ((WRITES_LAST_ARG.test(name) || MOVES.test(name)) && dest && isMedia(dest)) {
      block(`${name} would write into media/: ${dest}`);
    }
    if (name === "tee" && positional.some(isMedia)) block(`tee would write into media/: ${part.trim()}`);
    if (name === "dd" && rest.some((t) => /^of=/i.test(t) && isMedia(t.slice(3)))) {
      block(`dd would write into media/: ${part.trim()}`);
    }
    if (DELETES_OR_MOVES.test(name)) {
      // A move's destination may be a big folder like `.`; only its sources are removed.
      const targets = MOVES.test(name) ? positional.filter((t) => t !== dest) : positional;
      const hit = targets.find(containsFootage);
      if (hit) block(`${name} on ${hit} would delete or move original footage`);
    }
    if (name === "find" && /\s-(delete|exec\s+(rm|del|remove-item))\b/i.test(part)) {
      const starts = [];
      for (const t of rest) {
        if (/^[-(!]/.test(t)) break;
        starts.push(t);
      }
      const hit = (starts.length ? starts : ["."]).find(containsFootage);
      if (hit) block(`find -delete under ${hit} would delete original footage`);
    }
  }
}
