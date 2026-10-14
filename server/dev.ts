// `npm run dev`: starts the API server (restarting it when server code changes) and the
// Vite dev server for the browser app. Stopping one stops both.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

const children: ChildProcess[] = [
  spawn(process.execPath, ["--watch-path=server", "--watch-path=schema", "server/index.ts"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [viteBin], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}

for (const child of children) child.on("exit", (code) => stopAll(code ?? 0));
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
