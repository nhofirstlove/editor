#!/usr/bin/env node
// PreToolUse hook: stops hand edits to files that tools generate, and says how to
// change them properly. Exit code 2 blocks the edit and shows the message to Claude.

import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // Not valid hook input; don't get in the way.
}

const file = String(input.tool_input?.file_path ?? "").replaceAll("\\", "/");

const GENERATED = [
  {
    test: /(^|\/)schema\/timeline\.schema\.json$/,
    why: "schema/timeline.schema.json is generated from the zod schema.",
    instead: "Edit schema/timeline.ts, then run `npm run schema` to regenerate it.",
  },
  {
    test: /(^|\/)tests\/__snapshots__\//,
    why: "Snapshot files are written by Vitest.",
    instead:
      "Change the code or test, then run `npx vitest run <test file> -u` and read the snapshot diff to confirm the change is intended.",
  },
];

const hit = GENERATED.find((g) => g.test.test(file));
if (hit) {
  process.stderr.write(`Blocked by protect-generated hook: ${hit.why} ${hit.instead}\n`);
  process.exit(2);
}
process.exit(0);
