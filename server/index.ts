// Starts the API server. Bound to 127.0.0.1 so only this computer can reach it.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "./app.ts";
import { checkTools, stopAllFfmpeg } from "./ffmpeg.ts";

const port = Number(process.env.API_PORT ?? 5174);
// PROJECTS_DIR lets you point the editor at another folder (for example for testing).
const projectsDir = path.resolve(process.env.PROJECTS_DIR ?? fileURLToPath(new URL("../projects/", import.meta.url)));

const tools = checkTools();
if (!tools.ok) console.warn(`\n[!] ${tools.message}\n`);

await mkdir(projectsDir, { recursive: true });
const app = await buildServer({ projectsDir, tools });
try {
  await app.listen({ host: "127.0.0.1", port });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `Port ${port} is already in use, probably by another copy of the editor. Close it, or start with a different API_PORT.`
      : `The server could not start: ${(err as Error).message}`,
  );
  process.exit(1);
}
// Don't leave proxy encodes running after the server stops.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAllFfmpeg();
    process.exit(0);
  });
}

console.log(`API server listening on http://127.0.0.1:${port} (projects in ${projectsDir})`);
