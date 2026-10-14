// Real transcription through the API, with faster-whisper. Runs only where Python has
// faster-whisper and the small "base" model is already downloaded, so tests never
// download anything. The speech sample (tests/fixtures/speech.wav) was made with
// Windows text-to-speech and says: "Hello and welcome to the studio. Today we are
// talking about video editing. Um, this part should be removed. Thank you for watching,
// and see you next time."

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTranscriptJson } from "../schema/transcript.ts";
import type { ProjectResponse } from "../server/api-types.ts";
import { hasFfmpeg } from "./helpers/test-media.ts";
import { canTranscribe, speechSample as speech } from "./helpers/whisper.ts";

describe.skipIf(!hasFfmpeg || !canTranscribe)("transcription (needs faster-whisper and its base model)", () => {
  let app: Awaited<ReturnType<typeof import("../server/app.ts").buildServer>>;
  let idle: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    process.env.WHISPER_MODEL = "base"; // read when the server module loads
    const { buildServer } = await import("../server/app.ts");
    ({ idle } = await import("../server/jobs.ts"));
    const projectsDir = await mkdtemp(path.join(tmpdir(), "tve-transcribe-"));
    app = await buildServer({ projectsDir, tools: { ok: true }, watch: false });
    await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo" } });
    dir = path.join(projectsDir, "demo");
    await mkdir(path.join(dir, "media"), { recursive: true });
    // A video with the speech as its sound, starting 1 s in, to check times are source times.
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=gray:s=160x120:r=25:d=14",
      "-i", speech, "-af", "adelay=1000:all=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
      path.join(dir, "media", "talk.mp4"),
    ]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    await writeFile(
      path.join(dir, "timeline.json"),
      JSON.stringify({
        version: 1,
        sources: [{ id: "src1", path: "media/talk.mp4", duration: 13.2, audioChannels: 1 }],
        tracks: { main: [{ id: "c1", sourceId: "src1", in: 0, out: 13.2 }] },
      }),
    );
  }, 60_000);
  afterAll(() => app?.close());

  it("transcribes a source with word timestamps into transcript.json", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(before.media.src1.transcript.status).toBe("not-started");

    const res = await app.inject({ method: "POST", url: "/api/projects/demo/sources/src1/transcribe" });
    expect(res.statusCode).toBe(200);
    await idle();

    const after = (await app.inject({ method: "GET", url: "/api/projects/demo" })).json() as ProjectResponse;
    expect(after.media.src1.transcript).toMatchObject({ status: "ready" });

    const fromApi = (await app.inject({ method: "GET", url: after.media.src1.transcript.url! })).json();
    const parsed = parseTranscriptJson(await readFile(path.join(dir, "transcript.json"), "utf8"));
    expect(parsed.ok && parsed.transcript).toEqual(fromApi.transcript);

    const entry = fromApi.transcript.sources.src1;
    expect(entry).toMatchObject({ path: "media/talk.mp4", model: "base", language: "en" });
    const text = entry.words.map((w: { text: string }) => w.text).join(" ").toLowerCase();
    for (const expected of ["hello", "welcome", "studio", "video", "editing", "removed", "watching"]) expect(text).toContain(expected);

    // Times are source seconds: the speech starts 1 s into the video, and "Hello" ends
    // 0.34 s into the speech. (Whisper often starts the first word after a silence a
    // little early, so its end is the reliable check.)
    const hello = entry.words[0];
    expect(hello.text).toBe("Hello");
    expect(hello.end).toBeGreaterThan(1.2);
    expect(hello.end).toBeLessThan(1.5);
    expect(hello.start).toBeGreaterThan(0.5);
    const starts = entry.words.map((w: { start: number }) => w.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  }, 120_000);
});
